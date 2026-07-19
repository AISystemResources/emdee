/**
 * repair-zhihao-vault.mjs
 *
 * Fixes Zhihao's vault structure so the 5 key system nodes sit directly
 * under EMDEE, and personal content (ASTRAIL, WIB-INTERNSHIP, WORKSHOP)
 * sits under the ZHIHAO owner node.
 *
 * Changes:
 *   1. Create ZHIHAO.md (owner node, Child of EMDEE, Parent of personal content)
 *   2. Rewrite EMDEE.md — correct 5-child Parent of list
 *   3. Fix SHARED.md — Child of EMDEE (not VAULT)
 *   4. Fix VAULT.md — remove SHARED from Parent of
 *   5. Fix ASTRAIL.md — Child of ZHIHAO (not EMDEE)
 *   6. Fix WIB-INTERNSHIP.md — Child of ZHIHAO (not EMDEE)
 *   7. Fix WORKSHOP.md — Child of ZHIHAO (not EMDEE)
 *
 * Usage:
 *   node scripts/repair-zhihao-vault.mjs --dry-run
 *   node scripts/repair-zhihao-vault.mjs
 */

import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import { parseArgs } from "node:util";

dotenv.config({ path: ".env.local" });

const { values } = parseArgs({ options: { "dry-run": { type: "boolean", default: false } } });
const DRY_RUN = values["dry-run"];

const NS = "user_3FZUjBSvk00tGcs3QmOdCFa4Kgd";
const BUCKET = "vaults";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const WRITES = [
  {
    file_path: "ZHIHAO.md",
    content: `# ZHIHAO

> Personal workspace for Chye Zhi Hao.

## Child of

* [[EMDEE]]

## Parent of

* [[ASTRAIL]]
* [[WIB Internship Bonsai]]
* [[Workshop]]
`,
  },
  {
    file_path: "EMDEE.md",
    content: `# EMDEE

> Entry point for this Emdee vault. Read [[INFO]] for conventions and how the vault works.

This file should stay thin — a 30-second orientation. The bulk of "how does this vault work" lives in [[INFO]], and your actual content lives under [[VAULT]].

## Parent of

* [[VAULT]]
* [[SHARED]]
* [[GRAVEYARD]]
* [[IMAGES]]
* [[ZHIHAO]]
`,
  },
  {
    file_path: "SHARED.md",
    content: `# SHARED

> Docs that other users have shared into your vault. Visible to your MCP tools and renderer; the content lives in the owner's vault and is read-only here.

## Child of

* [[EMDEE]]
`,
  },
  {
    file_path: "VAULT.md",
    content: `# VAULT

> Meta-pillar for this vault — groups the docs about how the system itself works ([[INFO]] conventions, [[INSTRUCTIONS]] CEO operating protocol, [[BRAIN]] cross-project wisdom, [[WORKFLOWS]] concrete procedures).

## Child of

* [[EMDEE]]

## Parent of

* [[INFO]]
* [[INSTRUCTIONS]]
* [[BRAIN]]
* [[WORKFLOWS]]
`,
  },
];

// Files that only need their "Child of" section patched
const REPARENT = [
  { file_path: "ASTRAIL.md", old: "* [[EMDEE]]", newParent: "* [[ZHIHAO]]" },
  { file_path: "WIB-INTERNSHIP.md", old: "* [[EMDEE]]", newParent: "* [[ZHIHAO]]" },
  { file_path: "WORKSHOP.md", old: "* [[EMDEE]]", newParent: "* [[ZHIHAO]]" },
];

async function getStoredContent(filePath) {
  const { data } = await sb
    .from("vault_files")
    .select("content")
    .eq("namespace", NS)
    .eq("file_path", filePath)
    .single();
  return data?.content ?? null;
}

async function writeFile(filePath, content) {
  const storagePath = `${NS}/${filePath}`;
  console.log(`  write: ${filePath}`);
  if (DRY_RUN) return;

  const blob = new Blob([content], { type: "text/markdown; charset=utf-8" });
  const { error: storErr } = await sb.storage.from(BUCKET).upload(storagePath, blob, {
    upsert: true,
    contentType: "text/markdown; charset=utf-8",
  });
  if (storErr) { console.error(`    ✗ storage: ${storErr.message}`); return; }

  const { error: cacheErr } = await sb.from("vault_files").upsert(
    { namespace: NS, file_path: filePath, content, updated_at: new Date().toISOString() },
    { onConflict: "namespace,file_path" }
  );
  if (cacheErr) console.warn(`    ⚠ vault_files: ${cacheErr.message}`);
  else console.log(`    ✓ written`);
}

async function run() {
  console.log(`\n${DRY_RUN ? "DRY RUN — no changes will be made\n" : "LIVE RUN\n"}`);
  console.log(`Namespace: ${NS}\n`);

  // Step 1: full rewrites
  console.log("=== Full rewrites ===");
  for (const { file_path, content } of WRITES) {
    await writeFile(file_path, content);
  }

  // Step 2: reparent patches (Child of EMDEE → Child of ZHIHAO)
  console.log("\n=== Reparenting personal nodes ===");
  for (const { file_path, old: oldBullet, newParent } of REPARENT) {
    const current = await getStoredContent(file_path);
    if (!current) { console.log(`  skip (not found): ${file_path}`); continue; }
    if (!current.includes(oldBullet)) {
      console.log(`  skip (already patched or unexpected content): ${file_path}`);
      continue;
    }
    const patched = current.replace(oldBullet, newParent);
    console.log(`  reparent: ${file_path}  (${oldBullet} → ${newParent})`);
    if (!DRY_RUN) await writeFile(file_path, patched);
  }

  console.log("\n✅  Done. Run backfill-doc-edges to rebuild the graph:");
  console.log(`   npx tsx scripts/backfill-doc-edges.ts --namespace=${NS}`);
}

run().catch((e) => { console.error(e); process.exit(1); });
