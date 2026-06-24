/**
 * repair-emily-vault.mjs
 *
 * One-off: fixes Emily Lin's prod vault (user_3FZxd6zv0YOX2TlFnlHfH95HjSr).
 *
 * 1. Deletes stale May-2026 seed files that block system-node injection
 * 2. Writes the missing EMILY-RUIXIAN owner node
 * 3. Cleans vault_files cache and doc_edges for all removed paths
 *
 * Usage:
 *   node scripts/repair-emily-vault.mjs --dry-run
 *   node scripts/repair-emily-vault.mjs
 */

import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import { parseArgs } from "node:util";

dotenv.config({ path: ".env.local" });

const { values } = parseArgs({ options: { "dry-run": { type: "boolean", default: false } } });
const DRY_RUN = values["dry-run"];

const NS = "user_3FZxd6zv0YOX2TlFnlHfH95HjSr";
const BUCKET = "vaults";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// Stale files from the May-2026 seed that override or conflict with system nodes.
// vault/brain/** and vault/brain/university/** are Emily's own content — NOT deleted.
const STALE_PATHS = [
  `${NS}/EMDEE.md`,               // old content blocks the system node
  `${NS}/vault/BRAIN.md`,         // top-level hub replaced by EMDEE system node hierarchy
  `${NS}/vault/INFO.md`,
  `${NS}/vault/INSTRUCTIONS.md`,
  `${NS}/vault/info/SAMPLE.md`,
  `${NS}/vault/info/sample/ACME-WORKSPACE.md`,
  `${NS}/vault/info/sample/MAYA-CHEN.md`,
  `${NS}/vault/info/sample/TEMPLATE.md`,
];

const OWNER_PATH = `${NS}/EMILY-RUIXIAN.md`;
const OWNER_CONTENT = `# EMILY-RUIXIAN

> Your personal subtree. Top-level content (projects, people, notes, etc.) lives here. Renameable any time via \`rename_doc\` — inbound wiki-link references update atomically across the vault.

## Child of

* [[EMDEE]]

## Parent of

## Associated with

## Notes
`;

async function fileExists(path) {
  const parts = path.split("/");
  const name = parts.pop();
  const folder = parts.join("/");
  const { data } = await sb.storage.from(BUCKET).list(folder, { search: name, limit: 1 });
  return (data ?? []).some((f) => f.name === name && f.id !== null);
}

async function run() {
  console.log(`\n${DRY_RUN ? "DRY RUN — no changes will be made\n" : "LIVE RUN\n"}`);

  // --- Step 1: delete stale files ---
  const toDelete = [];
  for (const p of STALE_PATHS) {
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
    console.log(`  ✓ deleted ${toDelete.length} file(s) from storage`);

    // Clean vault_files cache
    const filePaths = toDelete.map((p) => p.slice(NS.length + 1));
    const { error: cacheErr } = await sb
      .from("vault_files")
      .delete()
      .eq("namespace", NS)
      .in("file_path", filePaths);
    if (cacheErr) console.warn(`  ⚠ vault_files cache cleanup: ${cacheErr.message}`);
    else console.log(`  ✓ purged ${filePaths.length} vault_files cache row(s)`);

    // Clean doc_edges
    const { error: edgeErr } = await sb
      .from("doc_edges")
      .delete()
      .eq("namespace", NS)
      .or(filePaths.map((p) => `from_path.eq.${p},to_path.eq.${p}`).join(","));
    if (edgeErr) console.warn(`  ⚠ doc_edges cleanup: ${edgeErr.message}`);
    else console.log(`  ✓ purged doc_edges for deleted paths`);
  }

  // --- Step 2: write owner node ---
  const ownerExists = await fileExists(OWNER_PATH);
  if (ownerExists) {
    console.log(`\n  owner node already exists: ${OWNER_PATH} — skipping`);
  } else {
    console.log(`\n  writing owner node: ${OWNER_PATH}`);
    if (!DRY_RUN) {
      const blob = new Blob([OWNER_CONTENT], { type: "text/markdown; charset=utf-8" });
      const { error } = await sb.storage.from(BUCKET).upload(OWNER_PATH, blob, {
        upsert: false,
        contentType: "text/markdown; charset=utf-8",
      });
      if (error) { console.error(`  ✗ storage write: ${error.message}`); process.exit(1); }
      console.log(`  ✓ written to storage`);

      // Upsert vault_files cache
      const { error: cacheErr } = await sb.from("vault_files").upsert(
        { namespace: NS, file_path: "EMILY-RUIXIAN.md", content: OWNER_CONTENT, updated_at: new Date().toISOString() },
        { onConflict: "namespace,file_path" }
      );
      if (cacheErr) console.warn(`  ⚠ vault_files cache write: ${cacheErr.message}`);
      else console.log(`  ✓ vault_files cache updated`);
    }
  }

  console.log("\n✅  Done.");
}

run().catch((e) => { console.error(e); process.exit(1); });
