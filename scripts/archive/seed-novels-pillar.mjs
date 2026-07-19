// One-off: swap the WRITING pillar for a NOVELS pillar and seed
// "Just 3 Guys" as the first book. Deletes the previous WRITING + NOVEL
// placeholders, updates EMDEE.md's Parent of list, writes everything
// through Storage + the vault_files cache.
//
// Run from project root: node scripts/seed-novels-pillar.mjs
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

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);
const bucket = sb.storage.from("vaults");

async function writeDoc(relPath, content) {
  const fullPath = `${NAMESPACE}/${relPath}`;
  const blob = new Blob([content], { type: "text/markdown; charset=utf-8" });
  const { error: upErr } = await bucket.upload(fullPath, blob, {
    upsert: true,
    contentType: "text/markdown; charset=utf-8",
  });
  if (upErr) throw new Error(`upload ${fullPath}: ${upErr.message}`);
  const { error: cacheErr } = await sb
    .from("vault_files")
    .upsert(
      { namespace: NAMESPACE, file_path: relPath, content, updated_at: new Date().toISOString() },
      { onConflict: "namespace,file_path" }
    );
  if (cacheErr) throw new Error(`cache ${relPath}: ${cacheErr.message}`);
  console.log(`  wrote ${relPath}`);
}

async function deleteDoc(relPath) {
  await bucket.remove([`${NAMESPACE}/${relPath}`]);
  await sb.from("vault_files").delete().match({ namespace: NAMESPACE, file_path: relPath });
  console.log(`  removed ${relPath}`);
}

async function readDoc(relPath) {
  const { data } = await sb
    .from("vault_files")
    .select("content")
    .match({ namespace: NAMESPACE, file_path: relPath })
    .maybeSingle();
  return data?.content ?? null;
}

const NOVELS = `# NOVELS

> Index of novel-length fiction projects. Distinct from [[PROJECTS]] — novels iterate by drafts and revisions, not sprints and releases, so the substructure under each novel is loose by default.

## Child of

* [[EMDEE]]

## Parent of

* [[Just 3 Guys]]
`;

const JUST_3_GUYS = `# Just 3 Guys

> Working sandbox for the novel "Just 3 Guys". Premise, characters, plot, and notes live here as sections until any one of them earns its own node (then \`split_doc\` extracts it).

## Child of

* [[NOVELS]]

## Premise

> One-sentence pitch — replace this placeholder once it lands.

* **Genre / form:**
* **Target reader:**
* **Comp titles:** two or three published works in the same neighbourhood — anchors scope and voice.

## Why this story

The author-level "why". If thin, the project is thin — come back to this before drafting.

## Themes

The questions the book asks, even if it never answers them.

*

## Characters

The three guys plus anyone essential.

* **Guy 1:** name + the want + the wedge.
* **Guy 2:**
* **Guy 3:**
* **Supporting:**

## Plot

Whatever scaffolding makes the story feel reachable.

* **Inciting incident:**
* **Midpoint:**
* **Climax:**
* **Resolution:**

## Chapters

Rough sequence. Numbered placeholders; flesh out as drafting progresses.

* Chapter 1 —
* Chapter 2 —

## Notes & research

References, observations, half-formed ideas. Promote anything that earns its own node.

*

## Open questions

The decisions deferred. Revisit when a draft demands an answer.

*
`;

async function swapWritingForNovelsInEmdee() {
  const emdee = await readDoc("EMDEE.md");
  if (!emdee) throw new Error("EMDEE.md not found");
  // If WRITING is present, swap it for NOVELS in place; otherwise just
  // make sure NOVELS exists in Parent of.
  if (/\[\[WRITING\]\]/.test(emdee)) {
    return emdee.replace(/\[\[WRITING\]\]/g, "[[NOVELS]]");
  }
  if (/\[\[NOVELS\]\]/.test(emdee)) return emdee;
  // Insert at the end of Parent of.
  const lines = emdee.split("\n");
  let inParentOf = false;
  let lastBulletIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Parent of\s*$/.test(lines[i])) { inParentOf = true; continue; }
    if (inParentOf) {
      if (/^##\s/.test(lines[i])) break;
      if (/^\s*\*\s/.test(lines[i])) lastBulletIdx = i;
    }
  }
  if (lastBulletIdx === -1) throw new Error("Parent of section not found in EMDEE.md");
  lines.splice(lastBulletIdx + 1, 0, "* [[NOVELS]]");
  return lines.join("\n");
}

console.log("Removing old WRITING placeholder docs…");
await deleteDoc("WRITING.md");
await deleteDoc("writing/NOVEL.md");

console.log("\nWriting NOVELS pillar + Just 3 Guys…");
const updatedEmdee = await swapWritingForNovelsInEmdee();
await writeDoc("EMDEE.md", updatedEmdee);
await writeDoc("NOVELS.md", NOVELS);
await writeDoc("novels/JUST-3-GUYS.md", JUST_3_GUYS);

console.log("\nDone.");
