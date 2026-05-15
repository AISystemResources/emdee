// One-off: seed a WRITING pillar + NOVEL exploration into Edmund's vault.
// Adds [[WRITING]] to EMDEE.md's Parent of list. NOVEL is a single doc
// with internal sections so brainstorming is low-friction; later it can
// be split into proper child nodes via the split_doc tool.
//
// Run from project root: node scripts/seed-novel.mjs
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

async function readDoc(relPath) {
  const { data } = await sb
    .from("vault_files")
    .select("content")
    .match({ namespace: NAMESPACE, file_path: relPath })
    .maybeSingle();
  return data?.content ?? null;
}

const WRITING = `# WRITING

> Index for non-software creative work — novels, essays, scripts, long-form drafts. Distinct from [[PROJECTS]] (software/products) so the structure can stay loose: writing iterates by drafts and revisions, not sprints and releases.

## Child of

* [[EMDEE]]

## Parent of

* [[NOVEL]]
`;

const NOVEL = `# NOVEL

> Exploration sandbox for a novel-writing opportunity. Working title TBD — rename this node once the premise crystallises. Single doc by design: brainstorm first, split into child nodes (CHARACTERS, PLOT, CHAPTERS…) once the shape is real.

## Child of

* [[WRITING]]

## Premise

> One-sentence pitch. What is this story actually about, in plain English? Replace this placeholder with a real logline before going deep on anything else.

* **Working title:**
* **Genre / form:** (literary, sci-fi, thriller, novella, serial…)
* **Target reader:** who is this for, and what do they want from it?
* **Comp titles:** two or three published works in the same neighbourhood — helps anchor scope and voice.

## Why this story

What makes it worth writing? The author-level "why" — not the marketing pitch. If this answer is thin, the project is thin; come back to it before drafting.

## Themes

The questions the book is asking, even if it never answers them.

*

## Characters

Cast list, lightweight. Just enough to navigate — split into a real CHARACTERS node once anyone earns it.

* **Protagonist:** name + one sentence on what they want and what's in the way.
* **Antagonist / counter-force:** name + the wedge between them and the protagonist.
* **Supporting:** anyone else essential to the spine.

## Plot

Three-act, beat-sheet, snowflake — whatever scaffolding makes the story feel reachable.

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

async function addWritingToEmdeeParentOf() {
  const emdee = await readDoc("EMDEE.md");
  if (!emdee) throw new Error("EMDEE.md not found");
  if (/\[\[WRITING\]\]/.test(emdee)) {
    console.log("  EMDEE.md already lists [[WRITING]] — skipping");
    return emdee;
  }
  // Insert [[WRITING]] at the end of the Parent of bullet list.
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
  lines.splice(lastBulletIdx + 1, 0, "* [[WRITING]]");
  return lines.join("\n");
}

console.log("Seeding WRITING + NOVEL…");
const updatedEmdee = await addWritingToEmdeeParentOf();
await writeDoc("EMDEE.md", updatedEmdee);
await writeDoc("WRITING.md", WRITING);
await writeDoc("writing/NOVEL.md", NOVEL);
console.log("\nDone.");
