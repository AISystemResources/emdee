// 2026-08-07: one-off repair for Lisa's (namespace `user_3FZ9TD43kqW4thrS5xam5smOpll`)
// 12 orphaned docs. Discovered while auditing every user's orphan_count via
// namespace_health after building the SPRINT-188 admin viewer.
//
// The 12 orphans are one of three kinds:
//   1. Structural (no `## Child of` section)             — 7 docs
//   2. Empty `## Child of` (heading present, no bullets)  — 3 docs
//   3. Markdown drift (`[[trading]]` unresolved)          — 2 docs
//
// Repair rules (per Edmund's explicit go-ahead 2026-08-07):
//   - Kinds 1 + 2 → prepend / inject `* [[LISA]]` under `## Child of`
//   - Kind 3 → text-replace `[[trading]]` → `[[DAYTRADING]]`
//     (Lisa's actual daytrading hub is `lisa/daytrading.md` titled `DAYTRADING`)
//
// Also updates `LISA.md`'s `## Parent of` to list the newly-parented docs,
// preserving edge reciprocity (HARD RULE 7).
//
// Storage write path: writes directly via the Supabase JS admin client using
// SUPABASE_SECRET_KEY from .env.local. The Storage → vault_files trigger keeps
// the cache coherent; a final backfillNamespace rebuilds doc_edges.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudDatabase } from "../../src/lib/database";
import { backfillNamespace } from "../../src/core/syncDocEdges";
import { SupabaseStorage } from "../../src/lib/storage/SupabaseStorage";

const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("Missing Supabase env vars.");

const supabase = createClient(url, key);
const storage = new SupabaseStorage();
const BUCKET = "vaults";
const NS = "user_3FZ9TD43kqW4thrS5xam5smOpll";
const OWNER_TITLE = "LISA";

// Structural + empty-Child-of docs — get `* [[LISA]]` injected.
const NEEDS_PARENT: string[] = [
  "//CO-LIVING-R2R-BUSINESS-GUIDE.md",
  "/HP-BATTERY-CONTROL-PROJECT.md",
  "coliving-business/COLIVING-SETUP-COMPLIANCE-MARKETING-LEGAL-TAKEAWAYS.md",
  "lisa/Besmakmur TA Generator.md",
  "lisa/Claude Learning Path.md",
  "lisa/co-living.md",
  "lisa/Tools.md",
  "lisa/windows-task-scheduler-wake-and-launch-guide.md",
  "lisa/windows-task-scheduler-workspace-setup.md",
  "rental-arbitrage/COLIVING-JB-PROJECT.md",
];

// Markdown-drift docs — text replace `[[trading]]` → `[[DAYTRADING]]`.
const TRADING_DRIFT: string[] = [
  "trading/S2-VOLUME-PROFILE-IMPACT.md",
  "trading/VOLUME-PROFILE-POC.md",
];

/**
 * Inject `* [[LISA]]` under `## Child of`. Three cases:
 *   A. No `## Child of` at all → insert full section after the H1 + summary
 *      preamble, before the first H2 heading (or end of file).
 *   B. `## Child of` exists but body is empty → insert `* [[LISA]]` right
 *      after the heading.
 *   C. Section exists with bullets already → no-op (defensive).
 */
function injectChildOf(content: string): string {
  const childOfMatch = content.match(/^##\s+Child of\s*$/im);
  if (childOfMatch && childOfMatch.index !== undefined) {
    // Case B/C: section exists. Find the body region.
    const heading = childOfMatch[0];
    const start = childOfMatch.index + heading.length;
    const nextH2 = content.slice(start).search(/^##\s/m);
    const bodyEnd = nextH2 === -1 ? content.length : start + nextH2;
    const body = content.slice(start, bodyEnd);
    if (/\[\[.+?\]\]/.test(body)) return content; // Case C — already has a bullet
    // Case B — insert bullet
    return content.slice(0, start) + `\n\n* [[${OWNER_TITLE}]]\n\n` + content.slice(bodyEnd);
  }
  // Case A — insert entire section after preamble.
  // Preamble = H1 line + optional blockquote lines. Find first H2 or end.
  const firstH2 = content.match(/^##\s/m);
  const insertAt = firstH2 && firstH2.index !== undefined ? firstH2.index : content.length;
  const injection = `## Child of\n\n* [[${OWNER_TITLE}]]\n\n`;
  return content.slice(0, insertAt) + injection + content.slice(insertAt);
}

async function readDoc(rel: string): Promise<string> {
  // Storage is canonical; my earlier writes updated it, so this returns
  // the freshest content even though vault_files is stale.
  const { data, error } = await supabase.storage.from(BUCKET).download(`${NS}/${rel}`);
  if (error || !data) throw new Error(`read failed for ${rel}: ${error?.message}`);
  return await data.text();
}

async function writeDoc(rel: string, content: string): Promise<void> {
  // Dual-write via the app's SupabaseStorage — updates Storage AND
  // upserts the vault_files cache row so orphan detection sees the change.
  await storage.write(`${NS}/${rel}`, content);
}

async function repairChildOf(rel: string): Promise<{ path: string; changed: boolean }> {
  const content = await readDoc(rel);
  const updated = injectChildOf(content);
  // Unconditional write — the first pass hit Storage only; the cache
  // (vault_files) is still stale. Rewriting via storage.write does the
  // dual-write and syncs the cache.
  await writeDoc(rel, updated);
  return { path: rel, changed: updated !== content };
}

async function repairTradingDrift(rel: string): Promise<{ path: string; changed: boolean }> {
  const content = await readDoc(rel);
  const updated = content.replace(/\[\[trading\]\]/g, "[[DAYTRADING]]");
  await writeDoc(rel, updated);
  return { path: rel, changed: updated !== content };
}

/** Idempotently ensure LISA.md's Parent of lists every child title. */
async function updateOwnerParentOfIdempotent(childTitles: string[]): Promise<void> {
  const lisa = await readDoc("LISA.md");
  const parentOfMatch = lisa.match(/^##\s+Parent of\s*$/im);
  const missing = childTitles.filter((t) => !lisa.includes(`[[${t}]]`));
  if (missing.length === 0) return;
  const bullets = missing.map((t) => `* [[${t}]]`).join("\n\n");
  let updated: string;
  if (parentOfMatch && parentOfMatch.index !== undefined) {
    const start = parentOfMatch.index + parentOfMatch[0].length;
    updated = lisa.slice(0, start) + `\n\n${bullets}` + lisa.slice(start);
  } else {
    updated = lisa + `\n\n## Parent of\n\n${bullets}\n`;
  }
  await writeDoc("LISA.md", updated);
}

async function fetchTitleForPath(rel: string): Promise<string> {
  const content = await readDoc(rel);
  const m = content.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : rel.replace(/\.md$/i, "");
}

async function main() {
  console.log(`Repair pass for ${NS}\n`);

  const childOfResults = [];
  for (const rel of NEEDS_PARENT) {
    const r = await repairChildOf(rel);
    console.log(`  ${r.changed ? "✓" : "·"} ${rel}`);
    childOfResults.push(r);
  }

  const tradingResults = [];
  for (const rel of TRADING_DRIFT) {
    const r = await repairTradingDrift(rel);
    console.log(`  ${r.changed ? "✓" : "·"} ${rel}  (trading → DAYTRADING)`);
    tradingResults.push(r);
  }

  // Reciprocity: ensure LISA.md's Parent of lists every newly-parented doc.
  // Idempotent — skip titles that already appear.
  const allParented = NEEDS_PARENT;
  const titles = [];
  for (const p of allParented) titles.push(await fetchTitleForPath(p));
  await updateOwnerParentOfIdempotent(titles);
  console.log(`\n  ✓ LISA.md Parent of ensured to list ${titles.length} children`);

  console.log(`\nRebuilding doc_edges for ${NS}…`);
  const db = cloudDatabase();
  const backfill = await backfillNamespace(db, NS);
  console.log(`  ${backfill.rows} rows written across ${backfill.docs} docs`);
  if (backfill.duplicate_parents.length > 0) {
    console.log(`  (${backfill.duplicate_parents.length} duplicate-parent conflicts resolved)`);
  }

  // Refresh namespace_health so the admin viewer shows the healed state.
  const { error: healthErr } = await supabase.rpc("compute_namespace_health", { ns: NS });
  if (healthErr) console.error(`  health refresh failed: ${healthErr.message}`);
  else console.log(`  namespace_health refreshed`);

  console.log(`\nDone.`);
}

main().catch((e) => {
  console.error("repair-lisa-orphans failed:", e);
  process.exit(1);
});
