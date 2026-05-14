// Clean up Supabase public/ namespace:
// 1. Delete unwanted files (types/*, sample/ATLAS-SEARCH, sample/QUERY-ROUTER)
// 2. Upload cleaned content for keepers (wiki-links only reference existing files)
//
// Run from project root: node scripts/clean-public-supabase.mjs
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Load .env.local
const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("Missing Supabase env vars");

const sb = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
const bucket = sb.storage.from("vaults");

// --- 1) DELETE unwanted files from public/ ---
const toDelete = [
  "public/types/CONCEPT.md",
  "public/types/HACKATHON.md",
  "public/types/NOVEL.md",
  "public/types/NOVEL/CHARACTERS.md",
  "public/types/NOVEL/DRAFT.md",
  "public/types/NOVEL/EDITS.md",
  "public/types/NOVEL/INBOX.md",
  "public/types/NOVEL/INSTRUCTIONS.md",
  "public/types/NOVEL/LEARNINGS.md",
  "public/types/NOVEL/OUTBOX.md",
  "public/types/NOVEL/PLOT.md",
  "public/types/NOVEL/WORLDBUILDING.md",
  "public/types/PERSON.md",
  "public/types/PROJECT.md",
  "public/types/PROJECT/BRAND.md",
  "public/types/PROJECT/BUILD.md",
  "public/types/PROJECT/IDEAS.md",
  "public/types/PROJECT/INBOX.md",
  "public/types/PROJECT/INSTRUCTIONS.md",
  "public/types/PROJECT/LEARNINGS.md",
  "public/types/PROJECT/LOGS.md",
  "public/types/PROJECT/OUTBOX.md",
  "public/types/PROJECT/SPRINT.md",
  "public/sample/ATLAS-SEARCH.md",
  "public/sample/QUERY-ROUTER.md",
];
console.log(`Deleting ${toDelete.length} files...`);
const { error: delErr } = await bucket.remove(toDelete);
if (delErr) console.error("delete error:", delErr.message);
else console.log("✓ Deleted");

// --- 2) UPLOAD cleaned content for keepers ---
const updates = {
  "public/EMDEE.md": `# EMDEE

> Entry point for this Emdee vault. Read [[INFO]] for conventions and how the vault works.

This file should stay thin — a 30-second orientation. The bulk of "how does this vault work" lives in [[INFO]], and your actual content lives under [[VAULT]].

## Parent of

* [[VAULT]]
`,

  "public/VAULT.md": `# VAULT

> Meta-pillar for this vault — groups the docs about how the system itself works ([[INFO]] conventions, [[INSTRUCTIONS]] CEO operating protocol, [[BRAIN]] cross-project wisdom, [[WORKFLOWS]] concrete procedures).

## Child of

* [[EMDEE]]

## Parent of

* [[INFO]]
* [[INSTRUCTIONS]]
* [[BRAIN]]
* [[WORKFLOWS]]
`,

  "public/BRAIN.md": `# BRAIN

> Cross-project distilled wisdom. The always-loaded prior for any agent working in this vault. Read this first to inherit accumulated lessons, working preferences, and anti-patterns that apply across all projects — before touching any specific project.

## Child of

* [[VAULT]]

## CONTEXT

BRAIN holds *cross-project* meta-learnings. Different from per-project \`LEARNINGS.md\` files:

- **Per-project LEARNINGS** = lessons specific to one codebase, domain, or team. Canonical for that project's facts.
- **BRAIN** = lessons that have shown up in 2+ projects. Patterns of working, anti-patterns, recurring failure modes, universally-applicable rules. NOT project-specific facts.

Rules for entry into BRAIN:

1. **Observed in ≥2 projects.** Single-project observations stay in that project's \`LEARNINGS.md\` until they recur elsewhere.
2. **Dated.** Format: \`[YYYY-MM] <lesson> — first seen in <project-a>, confirmed in <project-b>.\`
3. **Supersede explicitly.** When a new lesson contradicts an old one, mark the old one deprecated (move to LOGS with a "deprecated by" annotation) rather than silently overwriting. Confirmation bias is the largest failure mode of a central wisdom doc.
4. **Small and dense.** This doc is read every session as ambient context. If it grows past ~2K tokens of LEARNINGS, force a distillation pass: split into themes, archive low-yield entries.

## BUILD

Current cross-project themes — patterns you're actively watching for, questions you're trying to resolve across projects.

* (none yet)

## LEARNINGS

* (none yet — first cross-project pattern goes here)

## LOGS

* (no entries yet)
`,

  "public/INFO.md": `# INFO

> Conventions and reference for this Emdee vault. Humans browse these files in the renderer; agents (Claude, Cursor, Codex) read the same files through an MCP server. Both audiences see identical bytes — anything the LLM says is traceable back to a file you wrote.

[[EMDEE]] is the thin entry point. This doc holds the bulk of the conventions, the relationship rules, and the MCP tool reference. Read it once when you start a vault, refer back to it when you forget how something works.

The [[SAMPLE]] branch under this doc contains worked examples ([[ACME WORKSPACE]], [[MAYA CHEN]], [[TITLE]]) that demonstrate every convention in real content. Delete that whole branch when you no longer need it.

## Child of

* [[VAULT]]

## Parent of

* [[SAMPLE]]

## Conventions

### One H1 per file, one blockquote summary right under it

Every doc starts with a single \`#\` H1 (its title in the graph and sidebar). Directly below the H1, write a one-paragraph summary in a \`> blockquote\`. This summary is the routing decision for both humans and LLMs — read it to decide whether to drill into the full doc.

\`\`\`
# YOUR DOC NAME

> One- to three-sentence summary that lets a reader decide whether to drill in.

## Overview
...
\`\`\`

Keep summaries to 1–3 sentences. They're a table of contents, not a replacement for the doc.

### Wiki links

\`[[Other Doc Title]]\` connects this note to another by title (case-insensitive match on the other doc's H1).

### Folders

Nest under \`docs/\` (e.g. \`docs/projects/\`, \`docs/people/\`). The indexer walks recursively — folder layout is for your organization, not for the graph.

### Filenames

Filename matches the doc's H1 with spaces converted to hyphens. ASCII only.

- H1 \`MAYA CHEN\`        →  filename \`MAYA-CHEN.md\`
- H1 \`EMDEE\`            →  filename \`EMDEE.md\`
- H1 \`ACME WORKSPACE\`   →  filename \`ACME-WORKSPACE.md\`

## Relationships

Edges come from three named sections in any doc:

- \`## Parent of\` — list children with \`* [[NAME]]\`
- \`## Child of\` — list parents with \`* [[NAME]]\`
- \`## Associated with\` — list peers with \`* [[NAME]]\`, optionally followed by prose

\`Parent of\` and \`Child of\` are taxonomy: "what kind of thing is this, what contains it?" Index docs are the type anchors — declare them as parents of the things they contain. Hierarchy answers *what is this*.

\`Associated with\` is for everything else — collaborators, mentors, cross-cutting links. Association answers *how does it connect*.

### Prose after the wiki-link

In \`## Associated with\` bullets, write the relationship as prose after the leading wiki-link. Other wiki-links inside that prose are navigational hints, not new relationships.

Rules the indexer enforces:

1. **First link on the bullet = the declared edge.** That's the relationship this bullet asserts.
2. **Inline links inside the prose = context only.** They give humans and LLMs navigation hooks but do not create extra edges. To declare a separate relationship, write a separate bullet (usually in the other doc's file).
3. **Prose is optional.** A bare \`* [[NAME]]\` is valid and means "related, no extra context".
4. **Fenced code blocks are ignored.** The indexer skips \` \`\`\` \` fences entirely — sample bullets inside code blocks never become real edges.

Write the way you'd write to a friend. The LLM parses English fine; structure beyond a leading link is overkill.

## Doc structure

All docs share the universal base: H1 + \`> blockquote\` summary + relationship sections (Child of / Parent of / Associated with). The base is enforced by *convention*, not code — a doc that omits the summary still parses, it just becomes invisible to MCP \`get_summary\` retrieval.

For richer content domains (projects, people, events), it's common to add additional sections like CONTEXT, BUILD, LEARNINGS, LOGS — see [[BRAIN]] for the wisdom format and [[INSTRUCTIONS]] for the operating-protocol style.

## How agents should write here

1. Read existing docs before creating new ones — prefer extending an existing note over fragmenting.
2. When introducing a new concept that is referenced from multiple places, give it its own file and link with \`[[Concept Name]]\`.
3. Keep notes terse and link-rich. Prefer many small connected notes over one large document.
4. Always write a \`> summary\` line directly under the H1. If you don't, the MCP's \`get_summary\` and neighbor lookups return empty for this doc — making it invisible to cheap retrieval.

## MCP tools

The MCP server (\`emdee mcp\`) exposes:

- \`list_docs\` — every doc as \`{path, title, summary}\`. Cold-start enumeration.
- \`get_summary(path)\` — one doc's \`{path, title, summary}\`. Cheap.
- \`get_neighbors(path)\` — focal doc + 1-hop neighbors, categorized as \`parents / children / associated\`, each \`{path, title, summary, note}\`. Also returns \`mentioned_in\` for inline references from elsewhere.
- \`get_doc(path)\` — full markdown. More expensive — call after deciding the body is needed.
- \`search(query)\` — substring match over titles, summaries, content.
- \`write_doc(path, content)\` — create or overwrite a doc.
- \`append_section(path, heading, content)\` — append to a named section.
- \`patch_section(path, heading, new_content, expected_content_hash)\` — replace a section atomically.

Prefer the section-scoped writes when editing; \`write_doc\` replaces the whole file and silently drops anything not in the payload.
`,

  "public/INSTRUCTIONS.md": `# INSTRUCTIONS

> Vault-level operating protocol — defines how agents operate at the vault level: weekly distillation cadence and what gets written to [[BRAIN]].

[[EMDEE]] is the vault's identity. [[INFO]] holds the doc-system conventions. [[BRAIN]] holds the distilled cross-project wisdom. This doc holds the *operating protocol* — how the CEO agent (and any human standing in for it) actually works across all of those.

## Child of

* [[VAULT]]

## Roles in this vault

Three roles, arranged by scope:

- **DevOps** (per-project) — builds. Reads BUILD specs, ships code, writes close-outs. Produces raw signal: code changes, sprint outputs, log entries. The role you spend the most time talking to.
- **PO** (per-project) — plans. Reads INBOX, plans into BUILD, triages between BUILD and IDEAS, distills LOGS into LEARNINGS. Writes to OUTBOX when proposing to other projects. Bridges DevOps execution and CEO oversight.
- **CEO** (vault-level) — distills and routes across projects. Reads every project's OUTBOX, writes proposals into target projects' INBOX. Distills LEARNINGS across projects into [[BRAIN]]. Owns the meta-learning layer.

Each role's detailed operating protocol lives in the scope-appropriate INSTRUCTIONS doc:

- Per-project DevOps + PO protocol → \`docs/projects/<P>/INSTRUCTIONS.md\`
- Vault-level CEO protocol → this doc

## CEO operating protocol

### Session start

When the CEO agent starts a session:

1. Read [[EMDEE]] for vault identity.
2. Read [[BRAIN]] for cross-project priors.
3. List recent OUTBOX entries across all projects.
4. List recent LEARNINGS additions across all projects.
5. Only then decide what to act on.

### Weekly distillation

Triggered on a weekly cadence (e.g. Sunday). The CEO performs three passes:

1. **OUTBOX → INBOX routing.** Read each project's OUTBOX. For every entry tagged with a target project, write a corresponding entry into that target project's INBOX. Mark the source OUTBOX entry as \`routed\` (don't delete — provenance stays).
2. **Cross-project LEARNINGS scan.** Read the LEARNINGS docs added or updated this week across all projects. Identify entries that appear in ≥2 projects (the BRAIN promotion criterion).
3. **BRAIN update.** Add at most 5 new BRAIN entries per week — quality over quantity. Each entry cites its sources. Sign with \`— <author>, YYYY-MM-DD\`.

If a BRAIN candidate doesn't pass the three-test filter (reusable, non-obvious, has a directive), it stays in per-project LEARNINGS. The whole point of the filter is to keep BRAIN dense.

### Cross-project proposals

When the CEO sees a pattern that warrants action in a project, it writes to that project's INBOX — not directly to BUILD. The project's PO agent triages the INBOX on its own cadence. Lane discipline: **CEO proposes, never executes**.

### Boundaries

- CEO never writes to BUILD, LOGS, or CONTEXT of any project. Those belong to per-project agents.
- CEO writes to BRAIN, project INBOXes, and (rarely) EMDEE.md and this INSTRUCTIONS doc itself for protocol updates.
- CEO never deletes existing LEARNINGS or BRAIN entries. To supersede, write a new entry that explicitly cites the old one.

## Writing discipline

Use the MCP's section-scoped tools, not \`write_doc\`:

- \`append_section\` for new bullets, new LEARNINGS entries, new BRAIN entries, INBOX additions.
- \`patch_section\` for editing an existing section's body — always with \`expected_content_hash\` from the most recent read.
- \`write_doc_preview\` before any \`write_doc\`, no exceptions. Read the diff before you ship.

\`write_doc\` replaces the entire file and silently deletes anything not in the payload. Section-scoped writes make accidents structurally harder.
`,

  "public/WORKFLOWS.md": `# WORKFLOWS

> Concrete procedures the vault executes — triggered actions with defined inputs, steps, hooks, and outputs. Distinct from [[INSTRUCTIONS]] (operating protocol: "how to work in this scope") and [[INFO]] (conventions: "how the docs work"). Workflows are the things that actually run.

## Child of

* [[VAULT]]

## Convention

Each workflow lives at \`docs/workflows/<name>.md\`, declares \`Child of [[WORKFLOWS]]\`, and contains five sections:

* **Trigger** — schedule, event, or manual.
* **Inputs** — what docs / external sources it reads.
* **Steps** — ordered procedure.
* **Outputs** — what artifacts / writes it produces.
* **Hooks** — \`on-error\`, \`on-success\`, or other side effects.

The schema is intentionally loose. Formalize after running 3+ workflows manually and seeing what shape generalizes. Premature schema is the trap to avoid.

## Per-project workflows

Each project can also have its own \`docs/projects/<P>/workflows/\` folder for project-scoped procedures. The recursive pattern — same five sections, scoped to that project's docs. Cross-project orchestration lives at this vault level; per-project sprint loops live inside the project.
`,

  "public/SAMPLE.md": `# SAMPLE

> Pedagogical branch holding worked examples that demonstrate every convention in real content. [[TITLE]] is the blank skeleton; the rest ([[ACME WORKSPACE]], [[MAYA CHEN]]) are a coherent example showing how a real vault feels.

This whole branch is scaffolding. Read it once, then delete it with \`rm -rf docs/sample/\` when you're ready to write your own real content. The conventions all live in [[INFO]] — the samples just show them in action.

## Child of

* [[INFO]]

## Parent of

* [[TITLE]]
* [[ACME WORKSPACE]]
* [[MAYA CHEN]]

## What the examples demonstrate

* [[TITLE]] — the blank skeleton you copy when creating a new doc. Shows every optional section.
* [[ACME WORKSPACE]] — an index/workspace doc. Demonstrates the \`Parent of\` taxonomy pattern.
* [[MAYA CHEN]] — a person doc. Demonstrates \`Associated with\` plus the prose-after-link convention, including inline \`[[wiki-links]]\` that are context hints rather than declared edges.
`,

  "public/sample/ACME-WORKSPACE.md": `# ACME WORKSPACE

> Example workspace doc grouping everything related to the fictional Acme project — a small team building an internal semantic search service. Acts as the top-level index for the sample docs in this vault.

This sample exists to show how an index/taxonomy doc looks. In a real vault, this is where you'd keep a one-screen overview of a company, a workspace, a research area, or any other broad container that has multiple things "inside" it. The \`Parent of\` section is what makes it an index: every doc listed there inherits this one as its taxonomic parent.

## Overview

Acme is a fictional company building internal tooling. The team is small (a few engineers), and they keep an Emdee vault to navigate their docs. This sample shows how their top-level workspace doc looks — a one-screen overview that an index doc would carry in a real vault.

## Child of

* [[SAMPLE]]

## Associated with

* [[MAYA CHEN]] — engineer on the team; demonstrates how a person doc associates back to a workspace

## Notes

* Use index docs sparingly — they earn their keep when you have at least 3–4 children worth grouping. One-child indexes are usually noise; just link directly.
* The whole sample set is seeded purely to demonstrate conventions. Once you understand the structure, delete them with \`rm -rf docs/sample/\` and start writing your real vault.
`,

  "public/sample/MAYA-CHEN.md": `# MAYA CHEN

> Engineer at [[ACME WORKSPACE]]. Came from a recsys background; strong opinions on offline vs online evaluation. Example person doc demonstrating the prose-after-wiki-link convention.

Maya is a fictional engineer used to demonstrate how a person doc looks in this vault. Before Acme she spent four years on recommendation systems at a larger company, which is where her instincts about eval methodology come from — she's been the one pushing the team to take held-out evaluation seriously rather than tuning on whatever feels right.

## Child of

* [[SAMPLE]]

## Associated with

* [[ACME WORKSPACE]] — engineer on the team; this is the leading link, so it's the declared edge

## Notes

* Strong opinions on offline eval vs online metrics — worth a longer conversation when planning the next experiment cycle.
* Example data only — replace with real people in your own vault, or delete the whole \`docs/sample/\` branch when you no longer need it.

## Contact

* maya@example.com
`,

  "public/sample/TEMPLATE.md": `# TITLE

> 1–3 sentence summary. This is the highest-leverage line in the doc; \`get_summary\` returns ONLY this. Be specific enough to decide whether to drill in.

## Child of

* [[SAMPLE]]

## CONTEXT

Optional. 1–3 paragraphs of stable background that the summary couldn't fit. Delete this section if the summary alone is enough.

## Notes

* Replace H1, summary, and body with your actual content.
* Pick from these sections as you need them; delete the rest.
* Universal sections every doc should have: H1, blockquote summary, and at least one relationship section (Child of / Parent of / Associated with).

<!--
How to use this template:

Universal sections (every doc):
  - H1 title (this file uses placeholder "TITLE" — rename when you copy it)
  - Blockquote summary directly below the H1
  - Relationship sections: Child of, Parent of, Associated with

Optional sections (use as needed):
  - CONTEXT — stable background prose.
  - BUILD / LEARNINGS / LOGS — for active-work docs like projects.
  - NOTES, LINKS, etc. — any other content sections.

Order: H1 → summary → optional intro paragraph → Child of → Parent of → Associated with → CONTEXT → other sections → LOGS

The first wiki-link on each bullet under a relationship section is the declared edge. Inline wiki-links in prose are navigation hints, not edges.
-->
`,
};

const uploads = Object.entries(updates);
console.log(`Uploading ${uploads.length} cleaned files...`);
for (const [filePath, content] of uploads) {
  const blob = new Blob([content], { type: "text/markdown; charset=utf-8" });
  const { error } = await bucket.upload(filePath, blob, { upsert: true, contentType: "text/markdown; charset=utf-8" });
  if (error) console.error(`  ✗ ${filePath}: ${error.message}`);
  else console.log(`  ✓ ${filePath}`);
}

// --- 3) List what remains ---
async function walk(folder) {
  const { data } = await bucket.list(folder, { limit: 1000 });
  if (!data) return [];
  const out = [];
  for (const item of data) {
    const itemPath = folder ? `${folder}/${item.name}` : item.name;
    if (item.id === null) out.push(...(await walk(itemPath)));
    else out.push(itemPath);
  }
  return out;
}
const remaining = await walk("public");
console.log("\n=== Remaining files in public/ ===");
remaining.sort().forEach((f) => console.log(f));
console.log(`Total: ${remaining.length} files`);
