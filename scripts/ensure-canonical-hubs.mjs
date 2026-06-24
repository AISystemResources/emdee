/**
 * ensure-canonical-hubs.mjs
 *
 * Script 1 of the SPRINT-066 vault restructure.
 *
 * Creates the four canonical top-level hub nodes for every user namespace
 * that's missing them: GRAVEYARD.md, VAULT.md, IMAGES.md. The owner node
 * ({NAME}.md) is already seeded by ensureOwnerNode on first sign-in; this
 * script only creates the three OS-default hubs that may be absent.
 *
 * Each hub file is a standard EMDEE scaffold: H1 + blockquote summary +
 * ## Child of [[EMDEE]] + empty ## Parent of + ## Notes. Idempotent — skips
 * any file that already exists in Storage.
 *
 * Usage:
 *   node scripts/ensure-canonical-hubs.mjs --dry-run            # preview
 *   node scripts/ensure-canonical-hubs.mjs                       # all users
 *   node scripts/ensure-canonical-hubs.mjs --namespace=user_xxx  # one user
 *
 * Prerequisites:
 *   NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local
 */

import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import { parseArgs } from "node:util";

// env loaded after parseArgs so --env-file takes effect

const { values } = parseArgs({
  options: {
    "dry-run":   { type: "boolean", default: false },
    "namespace": { type: "string" },
    "env-file":  { type: "string", default: ".env.local" },
  },
});
const DRY_RUN = values["dry-run"];
const TARGET_NS = values["namespace"] ?? null;

dotenv.config({ path: values["env-file"], override: true });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

// Canonical hub definitions. Content is the same for every user — the system
// defaults. Users can customise after creation via MCP (write_doc / patch_section).
const CANONICAL_HUBS = [
  {
    filename: "GRAVEYARD.md",
    title: "GRAVEYARD",
    summary: "Archived and retired documents.",
    notes: "Docs moved here are soft-deleted — they remain readable and fully restorable.",
  },
  {
    filename: "VAULT.md",
    title: "VAULT",
    summary: "Skills, protocols, and shared knowledge that shape the whole vault.",
    notes: "System-seeded items (SKILLS, PROTOCOLS) live here alongside anything you add.",
  },
  {
    filename: "IMAGES.md",
    title: "IMAGES",
    summary: "Images and visual assets.",
    notes: "All uploaded images are stored under the IMAGES/ folder and linked from here.",
  },
];

function hubContent({ title, summary, notes }) {
  return `# ${title}

> ${summary}

## Child of

* [[EMDEE]]

## Parent of

## Notes

${notes}
`;
}

async function getAllNamespaces() {
  // Collect distinct namespaces from vault_files. Paginate to handle large sets.
  const namespaces = new Set();
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("vault_files")
      .select("namespace")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const row of data) namespaces.add(row.namespace);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return [...namespaces].sort();
}

async function fileExistsInStorage(path) {
  // Supabase Storage list() on the parent prefix, then check if name is present.
  const lastSlash = path.lastIndexOf("/");
  const folder = lastSlash >= 0 ? path.slice(0, lastSlash) : "";
  const name = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  const { data } = await supabase.storage.from("vaults").list(folder, { limit: 1000 });
  return (data ?? []).some((f) => f.name === name);
}

async function writeStorageFile(path, content) {
  const { error } = await supabase.storage
    .from("vaults")
    .upload(path, new TextEncoder().encode(content), {
      contentType: "text/markdown",
      upsert: false, // never overwrite existing
    });
  if (error && error.message !== "The resource already exists") throw error;
}

async function upsertVaultFile(namespace, filePath, content) {
  const now = new Date().toISOString();
  const { error } = await supabase.from("vault_files").upsert(
    { namespace, file_path: filePath, content, updated_at: now },
    { onConflict: "namespace,file_path" },
  );
  if (error) throw error;
}

async function ensureHubsForNamespace(ns) {
  console.log(`\n── ${ns} ──`);
  let created = 0;
  let skipped = 0;

  for (const hub of CANONICAL_HUBS) {
    const storagePath = `${ns}/${hub.filename}`;
    const existsInStorage = await fileExistsInStorage(storagePath);

    // Check vault_files separately — they can get out of sync (e.g. a
    // previous run wrote to Storage but crashed before upserting vault_files).
    const { data: vfRow } = await supabase
      .from("vault_files")
      .select("file_path")
      .eq("namespace", ns)
      .eq("file_path", hub.filename)
      .maybeSingle();
    const existsInDb = !!vfRow;

    if (existsInStorage && existsInDb) {
      console.log(`  ✓ ${hub.filename} (exists — skip)`);
      skipped++;
      continue;
    }

    const content = hubContent(hub);
    const actions = [];
    if (!existsInStorage) actions.push("Storage");
    if (!existsInDb) actions.push("vault_files");
    console.log(`  + ${hub.filename} (${DRY_RUN ? "would create" : "creating"} ${actions.join(" + ")})`);

    if (!DRY_RUN) {
      if (!existsInStorage) await writeStorageFile(storagePath, content);
      if (!existsInDb) await upsertVaultFile(ns, hub.filename, content);
    }
    created++;
  }

  return { created, skipped };
}

async function run() {
  console.log(`\nensure-canonical-hubs — ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log("Canonical hubs: GRAVEYARD.md, VAULT.md, IMAGES.md\n");

  const namespaces = TARGET_NS ? [TARGET_NS] : await getAllNamespaces();
  console.log(`Namespaces to process: ${namespaces.length}`);
  if (TARGET_NS) console.log(`  (targeted: ${TARGET_NS})`);

  let totalCreated = 0;
  let totalSkipped = 0;

  for (const ns of namespaces) {
    // Skip the public namespace — it has its own separate seed logic.
    if (ns === "public") continue;
    const { created, skipped } = await ensureHubsForNamespace(ns);
    totalCreated += created;
    totalSkipped += skipped;
  }

  console.log(`\n${"─".repeat(40)}`);
  console.log(`Created: ${totalCreated}  |  Skipped (already exist): ${totalSkipped}`);
  if (DRY_RUN) console.log("(dry-run — no changes were made)");
  else console.log("\n✅  Done. Run backfill-doc-edges.ts per namespace to sync edges.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
