// One-off batch rename for Edmund's vault: SILENTMANE → EMDEE_OS.
// Renames the root doc (projects/SILENTMANE.md), every child file under
// projects/SILENTMANE/, rewrites their H1s, and patches every wiki-link
// across the user's namespace in a single pass. Updates sync_manifest
// path refs too so cloud sync stays consistent.
//
// Run from project root: node scripts/rename-silentmane-to-emdee-os.mjs
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const NAMESPACE = "user_3DbybqEDdQdhvmvBFTmpZEAcQLS";
const OLD_NAME = "SILENTMANE";
const NEW_NAME = "EMDEE_OS";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);
const bucket = sb.storage.from("vaults");

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Pull the whole namespace from the Postgres cache (one query) — that's
// the same data /api/index reads. Storage is canonical; the cache is in
// sync because every prior write went through SupabaseStorage's dual-write.
const { data: rows, error } = await sb
  .from("vault_files")
  .select("file_path, content")
  .eq("namespace", NAMESPACE);
if (error) throw error;
console.log(`Loaded ${rows.length} files from vault_files.`);

// Build the rename plan: every doc whose path lives under the SILENTMANE
// project tree gets a new path + new H1 title.
const renames = []; // { oldPath, newPath, oldTitle, newTitle }
const titleMap = new Map(); // lowercased old title → new title (case-insensitive lookup)

for (const r of rows) {
  if (r.file_path === `projects/${OLD_NAME}.md`) {
    renames.push({
      oldPath: r.file_path,
      newPath: `projects/${NEW_NAME}.md`,
      oldTitle: OLD_NAME,
      newTitle: NEW_NAME,
    });
    titleMap.set(OLD_NAME.toLowerCase(), NEW_NAME);
  } else if (r.file_path.startsWith(`projects/${OLD_NAME}/`)) {
    const h1Match = r.content.match(/^#\s+(.+)$/m);
    const oldTitle = h1Match ? h1Match[1].trim() : path.basename(r.file_path, ".md");
    const newTitle = oldTitle.startsWith(`${OLD_NAME} — `)
      ? `${NEW_NAME} — ${oldTitle.slice(`${OLD_NAME} — `.length)}`
      : oldTitle.replace(OLD_NAME, NEW_NAME);
    renames.push({
      oldPath: r.file_path,
      newPath: r.file_path.replace(`projects/${OLD_NAME}/`, `projects/${NEW_NAME}/`),
      oldTitle,
      newTitle,
    });
    titleMap.set(oldTitle.toLowerCase(), newTitle);
  }
}
console.log(`\nRename plan (${renames.length} files):`);
for (const r of renames) console.log(`  ${r.oldTitle.padEnd(28)} → ${r.newTitle.padEnd(28)}  ${r.oldPath} → ${r.newPath}`);

// One regex matches any wiki-link to any renamed title. Sorted longest
// first so e.g. `[[SILENTMANE — BUILD]]` resolves to that alternative
// rather than backtracking past a shorter `[[SILENTMANE]]` match.
const sortedOldTitles = Array.from(titleMap.keys()).sort((a, b) => b.length - a.length);
const linkRe = new RegExp(`\\[\\[(${sortedOldTitles.map(escapeRegex).join("|")})(\\|[^\\]]+)?\\]\\]`, "gi");

function rewriteWikiLinks(content) {
  return content.replace(linkRe, (match, title, alias) => {
    const next = titleMap.get(title.toLowerCase());
    return next ? `[[${next}${alias ?? ""}]]` : match;
  });
}

function rewriteH1(content, newTitle) {
  if (/^#\s+.+$/m.test(content)) {
    return content.replace(/^#\s+.+$/m, `# ${newTitle}`);
  }
  return `# ${newTitle}\n\n> \n\n${content}`;
}

const renameByOldPath = new Map(renames.map((r) => [r.oldPath, r]));

console.log("\nApplying writes…");
let touched = 0;
let movedAway = [];
for (const r of rows) {
  const plan = renameByOldPath.get(r.file_path);
  let next = rewriteWikiLinks(r.content);
  if (plan) next = rewriteH1(next, plan.newTitle);
  if (next === r.content && !plan) continue;

  const newPath = plan ? plan.newPath : r.file_path;
  const fullStoragePath = `${NAMESPACE}/${newPath}`;
  const blob = new Blob([next], { type: "text/markdown; charset=utf-8" });
  const { error: upErr } = await bucket.upload(fullStoragePath, blob, {
    upsert: true,
    contentType: "text/markdown; charset=utf-8",
  });
  if (upErr) throw new Error(`upload ${fullStoragePath}: ${upErr.message}`);
  const { error: cacheErr } = await sb
    .from("vault_files")
    .upsert(
      { namespace: NAMESPACE, file_path: newPath, content: next, updated_at: new Date().toISOString() },
      { onConflict: "namespace,file_path" }
    );
  if (cacheErr) throw new Error(`cache upsert ${newPath}: ${cacheErr.message}`);

  if (plan && plan.oldPath !== newPath) movedAway.push(plan.oldPath);
  touched++;
}
console.log(`  ${touched} files written.`);

console.log("\nRemoving stale old paths…");
for (const oldPath of movedAway) {
  await bucket.remove([`${NAMESPACE}/${oldPath}`]);
  await sb.from("vault_files").delete().match({ namespace: NAMESPACE, file_path: oldPath });
  console.log(`  removed ${oldPath}`);
}

console.log("\nPatching sync_manifest paths…");
for (const r of renames) {
  const { error: smErr } = await sb
    .from("sync_manifest")
    .update({ file_path: `${NAMESPACE}/${r.newPath}` })
    .eq("clerk_id", NAMESPACE)
    .eq("file_path", `${NAMESPACE}/${r.oldPath}`);
  if (smErr) console.warn(`  sync_manifest ${r.oldPath}: ${smErr.message}`);
}

console.log("\nDone.");
