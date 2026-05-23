// One-shot: qualify `[[DAYn]]` wiki-links inside seminar atomic concept
// docs to the unambiguous `[[<SEMINAR> — DAYn]]` form. Otherwise a doc
// at `events/seminars/GBI/DAY1/X.md` declaring `Child of [[DAY1]]`
// depends on SFPDI/DAY1.md's H1 staying renamed to disambiguate — which
// has proven fragile (sync tabs keep reverting it).
//
// Writes go through Storage (canonical) AND the vault_files cache, so
// /api/index sees the change immediately without waiting for a cache
// refresh. Re-run safely — replacement is no-op if already qualified.
//
// Run: node scripts/qualify-day-links.mjs

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("Missing Supabase env vars (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SECRET_KEY).");

const sb = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
const bucket = sb.storage.from("vaults");

const NS = "user_3DbybqEDdQdhvmvBFTmpZEAcQLS";

// Note: Supabase Storage keys reject em-dash, so the qualified form uses
// a plain hyphen ([[SFPDI-DAY1]]) which matches the renamed file slug.
// We also normalize any earlier em-dash variant ([[SFPDI — DAY1]]) that
// an earlier pass produced.
const jobs = [
  { folder: "events/seminars/GBI/", days: ["DAY1", "DAY2", "DAY3", "DAY4"], prefix: "GBI" },
  { folder: "events/seminars/SFPDI/", days: ["DAY1", "DAY2"], prefix: "SFPDI" },
];

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

let totalChanged = 0;
for (const job of jobs) {
  const { data: files, error } = await sb
    .from("vault_files")
    .select("file_path, content")
    .eq("namespace", NS)
    .like("file_path", `${job.folder}%`)
    .like("file_path", "%.md");
  if (error) throw error;
  console.log(`\n${job.folder} — ${files.length} docs`);

  for (const f of files) {
    let updated = f.content;
    for (const day of job.days) {
      // 1) Normalize earlier em-dash qualified form to hyphen.
      const emDashRe = new RegExp(`\\[\\[${escapeRegex(job.prefix)}\\s*—\\s*${escapeRegex(day)}(\\|[^\\]]+)?\\]\\]`, "g");
      updated = updated.replace(emDashRe, (_m, alias) => `[[${job.prefix}-${day}${alias ?? ""}]]`);
      // 2) Bare [[DAYn]] → [[PREFIX-DAYn]] (preserve alias suffix).
      const bareRe = new RegExp(`\\[\\[${escapeRegex(day)}(\\|[^\\]]+)?\\]\\]`, "g");
      updated = updated.replace(bareRe, (_m, alias) => `[[${job.prefix}-${day}${alias ?? ""}]]`);
    }
    if (updated === f.content) continue;

    const storagePath = `${NS}/${f.file_path}`;
    const blob = new Blob([updated], { type: "text/markdown; charset=utf-8" });
    const { error: upErr } = await bucket.upload(storagePath, blob, {
      upsert: true,
      contentType: "text/markdown; charset=utf-8",
    });
    if (upErr) { console.error(`  ✗ storage ${storagePath}: ${upErr.message}`); continue; }

    const { error: cacheErr } = await sb
      .from("vault_files")
      .update({ content: updated, updated_at: new Date().toISOString() })
      .match({ namespace: NS, file_path: f.file_path });
    if (cacheErr) console.error(`  ✗ cache ${storagePath}: ${cacheErr.message}`);

    totalChanged++;
    console.log(`  ✓ ${f.file_path}`);
  }
}

console.log(`\n──────────────────────────────────────`);
console.log(`Done. ${totalChanged} docs updated.`);
