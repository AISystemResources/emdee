/**
 * Bulk storage-path rename for Edmund's vault.
 * For each affected file:
 *   1. Copy storage object to new path
 *   2. putFile (vault_files upsert) at new path
 *   3. deleteFile (vault_files delete) at old path
 *   4. Delete old storage object
 * Then rebuild doc_edges via backfillNamespace.
 *
 * Wiki-links are title-based so no content rewrites needed.
 */

import { createClient } from "@supabase/supabase-js";
import { cloudDatabase } from "../../src/lib/database/index";
import { backfillNamespace } from "../../src/core/syncDocEdges";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const NS = "user_3FXDLXbkdJ2TSWM0tc8SYMql9ZO";
const BUCKET = "vaults";

// Ordered rename rules: longest prefix first to avoid partial matches.
// Each is [oldPrefix, newPrefix]. Exact-match rules before prefix rules.
const RENAME_RULES: [string, string][] = [
  // ── WHATELZ-AI sub-docs (exact file renames, before folder rename) ──────
  // These are within projects/whatelz-ai/ which will become 03-projects/02-whatelz_ai/
  // so we write the final target paths directly.
  ["edmund/projects/whatelz-ai/CONTEXT.md",    "edmund/03-projects/02-whatelz_ai/01-CONTEXT.md"],
  ["edmund/projects/whatelz-ai/MARKETING.md",  "edmund/03-projects/02-whatelz_ai/02-MARKETING.md"],
  ["edmund/projects/whatelz-ai/PRODUCTION.md", "edmund/03-projects/02-whatelz_ai/03-PRODUCTION.md"],
  ["edmund/projects/whatelz-ai/OPERATION.md",  "edmund/03-projects/02-whatelz_ai/04-OPERATION.md"],

  // ── Project index .md files (exact, before folder prefix rules) ──────────
  ["edmund/projects/EMDEE_OS.md",    "edmund/03-projects/01-EMDEE_OS.md"],
  ["edmund/projects/WHATELZ-AI.md",  "edmund/03-projects/02-WHATELZ_AI.md"],
  ["edmund/projects/DOUBLELEAD.md",  "edmund/03-projects/03-DOUBLELEAD.md"],
  ["edmund/projects/ATLAS.md",       "edmund/03-projects/04-ATLAS.md"],

  // ── Project sub-folders ──────────────────────────────────────────────────
  ["edmund/projects/emdee_os/",   "edmund/03-projects/01-emdee_os/"],
  ["edmund/projects/whatelz-ai/", "edmund/03-projects/02-whatelz_ai/"],
  ["edmund/projects/doublelead/", "edmund/03-projects/03-doublelead/"],
  ["edmund/projects/atlas/",      "edmund/03-projects/04-atlas/"],

  // ── Entire projects/ folder (remaining files: ARCHIVE.md, ASR.md etc.) ──
  ["edmund/projects/", "edmund/03-projects/"],

  // ── Personal category folders ────────────────────────────────────────────
  ["edmund/personal/", "edmund/01-personal/"],
  ["edmund/business/", "edmund/02-business/"],
  ["edmund/research/", "edmund/05-research/"],
  ["edmund/career/",   "edmund/06-career/"],
  ["edmund/events/",   "edmund/07-events/"],
  ["edmund/people/",   "edmund/08-people/"],

  // ── Personal category index .md files ───────────────────────────────────
  ["edmund/PERSONAL.md",  "edmund/01-PERSONAL.md"],
  ["edmund/BUSINESS.md",  "edmund/02-BUSINESS.md"],
  ["edmund/PROJECTS.md",  "edmund/03-PROJECTS.md"],
  ["edmund/TEACHINGS.md", "edmund/04-TEACHINGS.md"],
  ["edmund/RESEARCH.md",  "edmund/05-RESEARCH.md"],
  ["edmund/CAREER.md",    "edmund/06-CAREER.md"],
  ["edmund/EVENTS.md",    "edmund/07-EVENTS.md"],
  ["edmund/PEOPLE.md",    "edmund/08-PEOPLE.md"],
  ["edmund/ARCHIVE.md",   "edmund/99-ARCHIVE.md"],
];

function applyRules(filePath: string): string {
  for (const [oldPfx, newPfx] of RENAME_RULES) {
    if (oldPfx.endsWith("/")) {
      if (filePath.startsWith(oldPfx)) {
        return newPfx + filePath.slice(oldPfx.length);
      }
    } else {
      if (filePath === oldPfx) return newPfx;
    }
  }
  return filePath; // unchanged
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
  const db = cloudDatabase();

  // 1. Load all files for the namespace (paginated)
  console.log("Loading vault_files...");
  const rows = await db.listFiles(NS, { select: "file_path, content, summary, summary_hash, content_hash_at_summary_write", order: "file_path_asc" });
  console.log(`  ${rows.length} files found`);

  // 2. Compute which files need renaming
  const toRename = rows
    .map(r => ({ old: r.file_path, new: applyRules(r.file_path), row: r }))
    .filter(x => x.old !== x.new);

  console.log(`\n${toRename.length} files to rename. Preview (first 20):`);
  toRename.slice(0, 20).forEach(x => console.log(`  ${x.old}\n    → ${x.new}`));
  if (toRename.length > 20) console.log(`  ... and ${toRename.length - 20} more`);

  if (toRename.length === 0) {
    console.log("Nothing to rename.");
    return;
  }

  // 3. Rename each file
  let done = 0;
  let errors = 0;
  for (const { old: oldPath, new: newPath, row } of toRename) {
    try {
      // a. Move storage object (atomic rename — no copy+delete)
      const { error: moveErr } = await supabase.storage
        .from(BUCKET)
        .move(`${NS}/${oldPath}`, `${NS}/${newPath}`);
      if (moveErr) throw new Error(`storage move failed: ${moveErr.message}`);

      // b. Upsert vault_files at new path (preserves content + summary hashes)
      await db.putFile(NS, newPath, row.content ?? "", {
        summary_hash: row.summary_hash ?? undefined,
        content_hash_at_summary_write: row.content_hash_at_summary_write ?? undefined,
      });

      // c. Delete old vault_files row
      await db.deleteFile(NS, oldPath);

      done++;
      if (done % 50 === 0) console.log(`  ${done}/${toRename.length} renamed...`);
    } catch (err) {
      console.error(`  ERROR renaming ${oldPath}: ${err}`);
      errors++;
    }
  }

  console.log(`\nRename complete: ${done} success, ${errors} errors`);

  // 4. Rebuild doc_edges
  console.log("\nRebuilding doc_edges...");
  const result = await backfillNamespace(db, NS);
  console.log(`Done: ${result.docs} docs, ${result.rows} edges, ${result.duplicate_parents.length} duplicate-parent warnings`);
  if (result.duplicate_parents.length > 0) {
    result.duplicate_parents.forEach(d => console.warn(`  dup-parent: ${d.child} (kept ${d.kept})`));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
