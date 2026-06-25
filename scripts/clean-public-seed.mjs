/**
 * clean-public-seed.mjs
 *
 * 1. Deletes stale files from the public/ seed in Supabase storage so future
 *    new-user vaults are seeded clean (system nodes handle EMDEE/VAULT/SHARED/
 *    GRAVEYARD/IMAGES; old INFO/BRAIN/INSTRUCTIONS/WORKFLOWS/sample demos removed).
 *
 * 2. Overwrites Emily's VAULT.md and SHARED.md with current system-node content
 *    (their stored copies have old content with dead wiki-links).
 *
 * Usage:
 *   node scripts/clean-public-seed.mjs --dry-run
 *   node scripts/clean-public-seed.mjs
 */

import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import { parseArgs } from "node:util";

dotenv.config({ path: ".env.local" });

const { values } = parseArgs({ options: { "dry-run": { type: "boolean", default: false } } });
const DRY_RUN = values["dry-run"];

const EMILY_NS = "user_3FZxd6zv0YOX2TlFnlHfH95HjSr";
const BUCKET = "vaults";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// Files to delete from public/ — system nodes (EMDEE/VAULT/SHARED) will inject
// current content for new users; demo files should never have been public-facing.
const PUBLIC_STALE = [
  "public/EMDEE.md",
  "public/BRAIN.md",
  "public/INFO.md",
  "public/INSTRUCTIONS.md",
  "public/SAMPLE.md",
  "public/SHARED.md",
  "public/VAULT.md",
  "public/WORKFLOWS.md",
  "public/sample/ACME-WORKSPACE.md",
  "public/sample/MAYA-CHEN.md",
  "public/sample/TEMPLATE.md",
];

// Emily's stored system-node files need overwriting — old seed gave them
// content that references defunct docs (INFO, BRAIN, INSTRUCTIONS, WORKFLOWS).
const EMILY_OVERRIDES = [
  {
    storagePath: `${EMILY_NS}/VAULT.md`,
    filePath: "VAULT.md",
    content: "# VAULT\n\n> Your private notes, projects, and knowledge.\n",
  },
  {
    storagePath: `${EMILY_NS}/SHARED.md`,
    filePath: "SHARED.md",
    content: "# SHARED\n\n> Content shared with you by others.\n",
  },
];

async function fileExists(path) {
  const parts = path.split("/");
  const name = parts.pop();
  const folder = parts.join("/");
  const { data } = await sb.storage.from(BUCKET).list(folder, { search: name, limit: 1 });
  return (data ?? []).some((f) => f.name === name && f.id !== null);
}

async function run() {
  console.log(`\n${DRY_RUN ? "DRY RUN — no changes will be made\n" : "LIVE RUN\n"}`);

  // --- Step 1: delete stale public/ files ---
  console.log("=== Cleaning public/ seed ===");
  const toDelete = [];
  for (const p of PUBLIC_STALE) {
    if (await fileExists(p)) {
      toDelete.push(p);
      console.log(`  stale: ${p}`);
    } else {
      console.log(`  skip (not found): ${p}`);
    }
  }

  if (toDelete.length > 0 && !DRY_RUN) {
    const { error } = await sb.storage.from(BUCKET).remove(toDelete);
    if (error) { console.error(`  ✗ storage delete: ${error.message}`); process.exit(1); }
    console.log(`  ✓ deleted ${toDelete.length} file(s) from public/ storage`);

    // Clean vault_files cache for public/ namespace
    const publicFilePaths = toDelete
      .filter((p) => p.startsWith("public/"))
      .map((p) => p.slice("public/".length));
    if (publicFilePaths.length > 0) {
      const { error: cacheErr } = await sb
        .from("vault_files")
        .delete()
        .eq("namespace", "public")
        .in("file_path", publicFilePaths);
      if (cacheErr) console.warn(`  ⚠ vault_files cache cleanup: ${cacheErr.message}`);
      else console.log(`  ✓ purged public vault_files cache rows`);
    }
  }

  // --- Step 2: overwrite Emily's stale system-node files ---
  console.log("\n=== Updating Emily's system-node files ===");
  for (const { storagePath, filePath, content } of EMILY_OVERRIDES) {
    const exists = await fileExists(storagePath);
    if (!exists) {
      console.log(`  skip (not found): ${storagePath}`);
      continue;
    }
    console.log(`  overwrite: ${storagePath}`);
    if (!DRY_RUN) {
      const blob = new Blob([content], { type: "text/markdown; charset=utf-8" });
      const { error } = await sb.storage.from(BUCKET).upload(storagePath, blob, {
        upsert: true,
        contentType: "text/markdown; charset=utf-8",
      });
      if (error) { console.error(`    ✗ storage write: ${error.message}`); continue; }

      const { error: cacheErr } = await sb.from("vault_files").upsert(
        { namespace: EMILY_NS, file_path: filePath, content, updated_at: new Date().toISOString() },
        { onConflict: "namespace,file_path" }
      );
      if (cacheErr) console.warn(`    ⚠ vault_files cache write: ${cacheErr.message}`);
      else console.log(`    ✓ written`);
    }
  }

  console.log("\n✅  Done.");
}

run().catch((e) => { console.error(e); process.exit(1); });
