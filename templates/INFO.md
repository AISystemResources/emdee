# INFO

> Conventions and reference for this Emdee vault. Humans browse these files in the renderer; agents (Claude, Cursor, Codex) read the same files through an MCP server. Both audiences see identical bytes — anything the LLM says is traceable back to a file you wrote.

[[MANE]] is the thin entry point. This doc holds the bulk of the conventions, the relationship rules, and the MCP tool reference. Read it once when you start a vault, refer back to it when you forget how something works.

The [[SAMPLE]] branch under this doc contains worked examples ([[TEMPLATE]], [[ACME WORKSPACE]], [[ATLAS SEARCH]], [[QUERY ROUTER]], [[MAYA CHEN]]) that demonstrate every convention in real content. Delete that whole branch when you no longer need it.

## Child of

* [[VAULT]]

## Associated with

* [[SILENTMANE]] — the software that implements these conventions; this is the project under [[PROJECTS]] that powers the vault renderer and the MCP

## Parent of

* [[SAMPLE]]

## Conventions

### One H1 per file, one blockquote summary right under it

Every doc starts with a single `#` H1 (its title in the graph and sidebar). Directly below the H1, write a one-paragraph summary in a `> blockquote`. This summary is the routing decision for both humans and LLMs — read it to decide whether to drill into the full doc.

```
# DOUBLELEAD

> Productivity app I'm co-founding with Sim Yee and Cody — early-stage, focused on team workflows. Started June 2024.

## Overview
...
```

Keep summaries to 1–3 sentences. They're a table of contents, not a replacement for the doc.

### Wiki links

`[[Other Doc Title]]` connects this note to another by title (case-insensitive match on the other doc's H1).

### Folders

Nest under `docs/` (e.g. `docs/projects/`, `docs/people/`). The indexer walks recursively — folder layout is for your organization, not for the graph.

### Filenames

Filename matches the doc's H1 with spaces converted to hyphens. ASCII only.

- H1 `MAYA CHEN`        →  filename `MAYA-CHEN.md`
- H1 `SILENTMANE`       →  filename `SILENTMANE.md`
- H1 `ATLAS SEARCH`     →  filename `ATLAS-SEARCH.md`

Tier files inside a project folder (`BUILD.md`, `LOGS.md`, `LEARNINGS.md`, `BRAND.md`, `IDEAS.md`) are an exception: filename is the bare tier name; H1 is qualified with the project — `SILENTMANE — BUILD`. The sidebar strips the `PARENT — ` prefix at display time, so the tree shows just `BUILD` under the SILENTMANE branch.

## Relationships

Edges come from three named sections in any doc:

- `## Parent of` — list children with `* [[NAME]]`
- `## Child of` — list parents with `* [[NAME]]`
- `## Associated with` — list peers with `* [[NAME]]`, optionally followed by prose

`Parent of` and `Child of` are taxonomy: "what kind of thing is this, what contains it?" Index docs are the type anchors — declare them as parents of the things they contain. Hierarchy answers *what is this*.

`Associated with` is for everything else — collaborators, mentors, projects-at-hackathons, anything cross-cutting. Association answers *how does it connect*.

### Prose after the wiki-link

In `## Associated with` bullets, write the relationship as prose after the leading wiki-link. Other wiki-links inside that prose are navigational hints, not new relationships.

```
## Associated with

* [[Doublelead]] — co-founder, building this with [[Sim Yee]] and [[Cody]] since June 2024
* [[AI Engineer Hackathon]] — built [[PokeAI]] here, teamed up with [[Zhi Hao]] and [[Shaun]]
```

Rules the indexer enforces:

1. **First link on the bullet = the declared edge.** That's the relationship this bullet asserts.
2. **Inline links inside the prose = context only.** They give humans and LLMs navigation hooks but do not create extra edges. To declare a separate relationship, write a separate bullet (usually in the other doc's file).
3. **Prose is optional.** A bare `* [[NAME]]` is valid and means "related, no extra context".
4. **Fenced code blocks are ignored.** The indexer skips ` ``` ` fences entirely — sample bullets inside code blocks (like the ones above) never become real edges.

Write the way you'd write to a friend. The LLM parses English fine; structure beyond a leading link is overkill.

## Doc types

Emdee is type-agnostic at the engineering layer — the indexer, MCP, and renderer just read markdown. Types live as conventions documented here, with templates in `templates/types/`. To add a new type, write a new template file. No code changes.

**Active work domains** (workspaces that evolve over time; front-door file + tier folder):

- **PROJECT** — software, products, services. Tier set: `INSTRUCTIONS, BUILD, LOGS, LEARNINGS, BRAND, IDEAS, INBOX, OUTBOX`. Template: `templates/types/PROJECT.md` + `templates/types/PROJECT/`.
- **NOVEL** — long-form fiction. Tier set: `INSTRUCTIONS, PLOT, CHARACTERS, WORLDBUILDING, DRAFT, EDITS, LEARNINGS, INBOX, OUTBOX`. Template: `templates/types/NOVEL.md` + `templates/types/NOVEL/`.

**Reference docs** (static or slow-changing; single file, no tier folder):

- **PERSON** — a person you work with. Body: Background, Notes, Interactions, Contact. Template: `templates/types/PERSON.md`.
- **HACKATHON** — an event you attended. Body: Details (when/where/status), Outcome, Reflections. Template: `templates/types/HACKATHON.md`.
- **CONCEPT** — a generic graph node that needs to exist but isn't a project, person, or event. Body: Context, Notes. Template: `templates/types/CONCEPT.md`.

All types share the universal base: H1 + `> blockquote` summary + relationship sections (Child of / Parent of / Associated with). The base is enforced by *convention*, not code — a doc that omits the summary still parses, it just becomes invisible to MCP `get_summary` retrieval.

**Adding a new type**: write `templates/types/NEW.md` (plus a folder if it's an active work domain), add a bullet here, and the system supports it. Zero code changes — the indexer, MCP, and renderer are type-agnostic.

## Writing conventions

### Attribution lines

Substantive sections (anything beyond a one-line bullet list) optionally end with a provenance line in italic-equivalent dash form:

```
— Claude Code, 2026-05-11
```

Or with source if the content was ported in:

```
— Claude Code, 2026-05-11 (sourced from atlas/CONTEXT, 2026-04-23)
```

Provenance lives in the markdown — no metadata layer, no schema. Whatever wrote the section signs it. Future readers (human or LLM) can trace any claim back to its source. Cheap, auditable, survives every view.

### Sprint authoring format

Sprints live as individual files at `docs/projects/<PROJECT>/sprints/SPRINT-NNN.md`. Each sprint earns its own file (not a section in BUILD) because close-outs grow over time and each sprint becomes a wiki-link target referenced from LEARNINGS, BRAIN, and elsewhere.

**Numbering:** zero-padded, monotonically increasing per project. **Always call `list_docs` or `mane list` against the project's `sprints/` folder before picking the next sprint number** — never guess from memory.

**H1 convention:** `PROJECT — SPRINT-NNN` (qualified for global uniqueness, same as tier files). The sidebar's prefix-trim displays just `SPRINT-NNN` under the project.

**Shape** (copy from `templates/types/PROJECT/SPRINT.md`):

````
# <PROJECT> — SPRINT-NNN

> One-line summary.

## Child of
* [[<PROJECT>]]

## Why
1–2 sentences. The problem this solves and why now.

## Scope
**In:** what's included
**Out:** what's explicitly excluded — prevents creep

## Acceptance criteria
* [ ] Measurable facts about the world
* [ ] Each criterion stands alone — verifiable by a different agent

## Deliverables
* Concrete files, behaviors, or artifacts

## Risks / open questions
* What we don't know yet

## Dependencies
* [[OTHER-SPRINT]] (if blocking)

— <author>, <YYYY-MM-DD> (spec)

## Close-out (added at ship time)
* Specced vs built deltas
* Blockers hit + how resolved
* LEARNINGS candidates

— <author>, <YYYY-MM-DD> (close-out)
````

**`BUILD.md` and `LOGS.md` act as views, not containers:**

- `BUILD.md` body lists active sprints (status `spec | in-progress`) as wiki-link bullets.
- `LOGS.md` body lists shipped sprints (status `shipped`) as wiki-link bullets.
- The `Status` field on each sprint file is the single source of truth; the BUILD/LOGS lists are curated indexes for navigation.

When a sprint closes, the body stays in its own file (`sprints/SPRINT-NNN.md`); only the index line moves from BUILD.md to LOGS.md.

### LEARNINGS authoring format

`LEARNINGS.md` entries follow a strict format proven across multiple projects. Each entry must pass a three-test filter before it earns a place:

1. **Reusable** — applies across future contexts or projects, not a one-off fix.
2. **Non-obvious in retrospect** — you wouldn't have known this six months ago.
3. **Has a directive** — do this / don't do this / instead do this.

Search the doc for near-duplicates before adding. Duplicates kill the doc.

Entry shape (under 100 words each):

````
## <Verb-first directive title>

**Context:** project, module, situation
**Trap:** what goes wrong without this knowledge
**Rule:** the actionable directive
**Finding:** (optional) observational discoveries about domain behaviour
**Source:** which BUILD or LOGS section produced this lesson

— <author>, <YYYY-MM-DD>
````

## How agents should write here

1. Read existing docs before creating new ones — prefer extending an existing note over fragmenting.
2. When introducing a new concept that is referenced from multiple places, give it its own file and link with `[[Concept Name]]`.
3. Keep notes terse and link-rich. Prefer many small connected notes over one large document.
4. Always write a `> summary` line directly under the H1. If you don't, the MCP's `get_summary` and neighbor lookups return empty for this doc — making it invisible to cheap retrieval.

## MCP tools

The MCP server (`mane mcp`) exposes:

- `list_docs` — every doc as `{path, title, summary}`. Cold-start enumeration.
- `get_summary(path)` — one doc's `{path, title, summary}`. Cheap.
- `get_neighbors(path)` — focal doc + 1-hop neighbors, categorized as `parents / children / associated`, each `{path, title, summary, note}`. Also returns `mentioned_in` for inline references from elsewhere.
- `get_doc(path)` — full markdown. More expensive — call after deciding the body is needed.
- `search(query)` — substring match over titles, summaries, content.
- `write_doc(path, content)` — create or overwrite a doc.

## Entry point convention

`EMDEE.md` at the docs root is the entry point. It's the doc you write first, the doc the LLM is expected to read on cold start, and the doc the renderer opens by default. If you have a strong reason to use a different filename, set `EMDEE_ENTRY=your-file.md` in the environment.

## Suggested structure

* `docs/MANE.md` — vault entry (identity, top-level pillars)
* `docs/VAULT.md` — vault-meta pillar anchor; groups INFO, INSTRUCTIONS, BRAIN
* `docs/INFO.md` — vault conventions (how the doc system works)
* `docs/INSTRUCTIONS.md` — vault-level operating protocol (CEO role: weekly distillation, cross-project routing)
* `docs/BRAIN.md` — cross-project distilled wisdom (always-loaded prior)
* `docs/WORKFLOWS.md` (+ `docs/workflows/`) — concrete procedures the vault executes; first one is `weekly-distillation.md` (Sunday CEO routine)
- `docs/SAMPLE.md` (+ `docs/sample/`) — pedagogical examples; delete the folder once you've read them
- `docs/PROJECTS.md` (+ `docs/projects/`) — one front-door file per active project, plus a folder per project holding the per-project tier set:
  - `docs/projects/PROJECT-NAME.md` — front-door (identity + relationships + CONTEXT)
  - `docs/projects/PROJECT-NAME/` — tier folder
    - `INSTRUCTIONS.md` — project-scoped operating protocol; first read when starting a session
    - `BUILD.md` — current sprint, 3–7 items
    - `LOGS.md` — append-only chronological history
    - `LEARNINGS.md` — distilled wisdom, see Writing conventions
    - `BRAND.md` — voice, colors, fonts (optional)
    - `IDEAS.md` — possibilities and future directions
    - `INBOX.md` — incoming proposals from other projects
    - `OUTBOX.md` — outgoing proposals to other projects
- `docs/PEOPLE.md` (+ `docs/people/`) — one file per person you work with. PEOPLE docs are single-file (no tier folder) — they're reference docs, not active workspaces.
- `docs/HACKATHONS.md` (+ `docs/hackathons/`) — one file per hackathon. Like PEOPLE, HACKATHONS docs are single-file (no tier folder) — reference docs, not active workspaces.
- `docs/EDUCATION.md` (+ `docs/education/`) — schools attended. CLHS / TC as single-file references; SIT as a folder with active modules (CAPSTONE / IWSP, each with its own tier files for academic deliverables).
- `docs/CAREER.md` (+ `docs/career/`) — professional roles. Single file per role; current role can grow tier files when it earns its own active workspace.
- `docs/notes/` — daily thinking, research, scratch
