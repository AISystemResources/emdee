// Idempotent seeder for the EMDEE e2e fixture vault.
//
// Walks `e2e/fixtures/vault/` and uploads every `.md` file into the
// EMDEE-test Supabase project's `public` namespace (Storage bucket
// `vaults` + Postgres table `vault_files`). Re-runs are free —
// `upload({ upsert: true })` + `upsert(onConflict)` no-op when content
// hasn't changed.
//
// Skipped on the upstream side: `doc_edges` sync. The smoke specs
// assert on rendered markdown (title text), not graph edges, and the
// upload spec exercises the full live `/api/image` path which writes
// edges itself. Keeping the seed surface minimal makes failures
// easier to attribute.
//
// Env requirements:
//   SUPABASE_TEST_URL              — EMDEE-test project URL
//   SUPABASE_TEST_SERVICE_ROLE_KEY — EMDEE-test admin JWT
//
// If either is missing the seed logs a warning and returns — local
// runs without test creds shouldn't fail. CI always has them.

import { createClient } from "@supabase/supabase-js";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_ROOT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const NAMESPACE = "public";
const STORAGE_BUCKET = "vaults";

async function walkMarkdown(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkMarkdown(full)));
    } else if (entry.name.endsWith(".md")) {
      results.push(full);
    }
  }
  return results;
}

export async function seedVault(): Promise<void> {
  const url = process.env.SUPABASE_TEST_URL;
  const key = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;

  if (!url || !key) {
    process.stdout.write(
      "[e2e seed] SUPABASE_TEST_URL / SUPABASE_TEST_SERVICE_ROLE_KEY missing — skipping seed. " +
        "Anonymous specs will assert against whatever's already in the target Supabase.\n",
    );
    return;
  }

  const admin = createClient(url, key, { auth: { persistSession: false } });
  const files = await walkMarkdown(FIXTURE_ROOT);

  let uploaded = 0;
  for (const absolute of files) {
    const rel = relative(FIXTURE_ROOT, absolute).replaceAll("\\", "/");
    const storagePath = `${NAMESPACE}/${rel}`;
    const content = await readFile(absolute, "utf8");

    // Storage upload — upsert is idempotent on identical bytes
    const { error: storageErr } = await admin.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, content, {
        upsert: true,
        contentType: "text/markdown",
      });
    if (storageErr) {
      throw new Error(`[e2e seed] storage upload failed for ${storagePath}: ${storageErr.message}`);
    }

    // vault_files upsert — keeps the Postgres cache in sync
    const { error: rowErr } = await admin.from("vault_files").upsert(
      {
        namespace: NAMESPACE,
        file_path: rel,
        content,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "namespace,file_path" },
    );
    if (rowErr) {
      throw new Error(`[e2e seed] vault_files upsert failed for ${rel}: ${rowErr.message}`);
    }

    uploaded++;
  }

  process.stdout.write(
    `[e2e seed] EMDEE-test public namespace: ${uploaded} fixture file(s) ensured.\n`,
  );
}
