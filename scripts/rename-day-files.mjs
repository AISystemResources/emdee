// One-shot: rename the seminar DAY hub files so the filename slug is
// globally unique. The qualify-day-links pass already updated every
// in-vault wiki-link reference to the hyphenated form, so this script
// only has to: rewrite H1 (em-dash for display), move the file in
// Storage, update the cache row, and patch doc_shares/sync_manifest.
//
// We deliberately do NOT use the rename_doc MCP — that tool also
// rewrites [[oldTitle]] across the whole vault, which would be wrong
// here because [[DAY1]] is ambiguous between SFPDI and GBI.
//
// Run: node scripts/rename-day-files.mjs

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
if (!url || !key) throw new Error("Missing Supabase env vars.");

const sb = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
const bucket = sb.storage.from("vaults");

const NS = "user_3DbybqEDdQdhvmvBFTmpZEAcQLS";

const renames = [
  { old: "events/seminars/SFPDI/DAY1.md", new: "events/seminars/SFPDI/SFPDI-DAY1.md", title: "SFPDI — DAY1" },
  { old: "events/seminars/SFPDI/DAY2.md", new: "events/seminars/SFPDI/SFPDI-DAY2.md", title: "SFPDI — DAY2" },
  { old: "events/seminars/GBI/DAY1.md",   new: "events/seminars/GBI/GBI-DAY1.md",     title: "GBI — DAY1" },
  { old: "events/seminars/GBI/DAY2.md",   new: "events/seminars/GBI/GBI-DAY2.md",     title: "GBI — DAY2" },
  { old: "events/seminars/GBI/DAY3.md",   new: "events/seminars/GBI/GBI-DAY3.md",     title: "GBI — DAY3" },
  { old: "events/seminars/GBI/DAY4.md",   new: "events/seminars/GBI/GBI-DAY4.md",     title: "GBI — DAY4" },
];

function rewriteH1(content, newTitle) {
  if (/^#\s+.+$/m.test(content)) {
    return content.replace(/^#\s+.+$/m, `# ${newTitle}`);
  }
  return `# ${newTitle}\n\n> \n\n${content}`;
}

for (const r of renames) {
  console.log(`\n${r.old} → ${r.new}`);

  // 1) Read current content from cache (canonical for this script's purposes).
  const { data: row, error: readErr } = await sb
    .from("vault_files")
    .select("content")
    .match({ namespace: NS, file_path: r.old })
    .maybeSingle();
  if (readErr) { console.error(`  ✗ read: ${readErr.message}`); continue; }
  if (!row) { console.log(`  · already renamed (no row at old path)`); continue; }

  const newContent = rewriteH1(row.content, r.title);

  // 2) Upload to new path in Storage.
  const newStoragePath = `${NS}/${r.new}`;
  const blob = new Blob([newContent], { type: "text/markdown; charset=utf-8" });
  const { error: upErr } = await bucket.upload(newStoragePath, blob, {
    upsert: true,
    contentType: "text/markdown; charset=utf-8",
  });
  if (upErr) { console.error(`  ✗ storage upload: ${upErr.message}`); continue; }

  // 3) Insert new cache row.
  const { error: insErr } = await sb
    .from("vault_files")
    .upsert(
      { namespace: NS, file_path: r.new, content: newContent, updated_at: new Date().toISOString() },
      { onConflict: "namespace,file_path" }
    );
  if (insErr) { console.error(`  ✗ cache insert: ${insErr.message}`); continue; }

  // 4) Delete old Storage object + cache row.
  const oldStoragePath = `${NS}/${r.old}`;
  await bucket.remove([oldStoragePath]);
  await sb.from("vault_files").delete().match({ namespace: NS, file_path: r.old });

  // 5) Update doc_shares / share_invitations / sync_manifest to point at the new path.
  await Promise.all([
    sb.from("doc_shares").update({ path_prefix: r.new })
      .eq("owner_id", NS).eq("path_prefix", r.old),
    sb.from("doc_shares").update({ share_root: r.new })
      .eq("owner_id", NS).eq("share_root", r.old),
    sb.from("share_invitations").update({ path_prefix: r.new })
      .eq("inviter_id", NS).eq("path_prefix", r.old),
    sb.from("share_invitations").update({ share_root: r.new })
      .eq("inviter_id", NS).eq("share_root", r.old),
    sb.from("sync_manifest").update({ file_path: `${NS}/${r.new}` })
      .eq("clerk_id", NS).eq("file_path", `${NS}/${r.old}`),
  ]);

  console.log(`  ✓ renamed`);
}

console.log(`\n──────────────────────────────────────`);
console.log(`Done. Now re-run: node scripts/backfill-doc-edges.mjs`);
