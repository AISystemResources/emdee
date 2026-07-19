# Emdee

A markdown knowledge graph shared by humans and their AI agents. Files you can edit like Obsidian, a vault you can share like Google Drive, and a live MCP endpoint every agent (Claude Code, Claude.ai, Cursor, Codex) reads and writes to natively. One vault, three surfaces — with the plain markdown you wrote as the only source of truth.

## Why

Every knowledge tool picks two of three: human-friendly, team-shareable, agent-native. Notion is human-friendly and shareable, but its blocks aren't markdown and agents can't natively touch them. Obsidian is human-friendly and agent-touchable (they're just markdown files), but private-by-default — sharing is a paid add-on or a git repo. Google Drive is shareable but not markdown-native. Emdee is all three: the markdown a human edits is the exact bytes an agent reads through MCP and a teammate reads through a share link — no hidden index, no parallel summaries, no schema gymnastics. Build up a working journal that survives across sessions and travels with the people you invite in.

## Install

**Claude Code plugin (recommended — MCP + CLI + skills in one shot):**

```bash
claude plugin install @aisystemresources/emdee
```

This installs the CLI, wires up the emdee.tech MCP server, and drops in 4 auto-loading skills. Then:

```bash
emdee login                          # PKCE flow, opens browser
emdee whoami                         # confirms your namespace
```

Slash commands available after install: `/vault-status`, `/describe-image <path>`, `/summarise [prefix]`.

**CLI-only (no plugin, for scripting or non-Claude-Code use):**

```bash
npm install -g @aisystemresources/emdee
cd ~/my-vault
emdee init --nickname "Your Name"    # writes ./docs/YOUR-NAME.md as your owner node
emdee list                           # your owner + 5 virtual system nodes
emdee mcp                            # stdio MCP server — point Claude Code at it
```

**claude.ai users:** the plugin doesn't apply (different install model). Use the connect panel on emdee.tech to add the HTTP MCP server directly.

## The 5-node OS layer

Every Emdee vault has exactly 5 canonical top-level nodes, plus your owner node:

| Node | Purpose |
|---|---|
| `EMDEE` | Vault root — the anchor everything hangs off. |
| `VAULT` | Your private notes, projects, and knowledge. |
| `SHARED` | Content shared with you by others (cloud only). |
| `GRAVEYARD` | Archived and retired documents. |
| `IMAGES` | Images and visual assets. |
| `<YOUR-NAME>` | Your personal subtree, seeded by `emdee init --nickname`. |

The 5 system nodes are **virtual** — they appear in every read (`emdee list`, `get_doc`, MCP responses) without being written to disk. Edit any of them via MCP and your version wins. Only the owner node (`<YOUR-NAME>.md`) actually lives on disk after `emdee init`.

## Quick start (developer / from source)

```bash
git clone https://github.com/AISystemResources/emdee.git
cd emdee
npm install
./bin/emdee.js init --nickname "You"   # seeds ./docs/ with your owner node
npm run dev                            # Next.js viewer at http://localhost:3000
npm run mcp                            # stdio MCP server
```

The web viewer (`emdee start`, `emdee serve-next`) is repo-only — it needs the Next.js `app/` tree that isn't in the published tarball. `init`, `list`, `drift-batch`, `mcp` all work from the global install.

## Claude Code skills

The package ships a set of `.md` skill files under `skills/` that teach Claude Code the vault conventions + workflows. Install them into your Claude Code skills directory:

```bash
emdee skills-install
```

This copies:

- **emdee-conventions** — always-loaded; teaches Claude the 5-node OS layer, doc shape, edge discipline, tool selection (CLI vs MCP), path conventions. Loading this once means Claude writes correctly to the vault the first time in every session.
- **emdee-describe-image** — auto-triggers on IMAGES/ docs with `_description pending_` summary. Runs the 4-step get-image → rename-doc → patch-preamble workflow.
- **emdee-summariser** — batch-refresh drifting doc summaries via `list-summary-drift`.
- **emdee-onboarder** — walks a new user from `emdee init` through their first project doc + connecting to Claude.

Re-run `emdee skills-install` after upgrading the package to pick up updated skill content.

## CLI

Every MCP tool has a matching `emdee <verb>` CLI command. Same guards, same errors, same semantics — 3–40× cheaper in tokens because the JSON-RPC envelope is skipped. Everything supports `--remote` (routes through emdee.tech via `POST /api/mcp`) or defaults local.

```bash
emdee login                                     # PKCE flow, saves creds to ~/.config/emdee/
emdee whoami
emdee list --remote                             # your live vault paths
emdee get-doc --path VAULT.md --full --remote   # full markdown
emdee create-child --parent-path VAULT.md --title "MY-PROJECT" --remote
emdee patch-section --path X --heading Notes --body "..." --expected-hash <hash> --remote
```

Full verb list via `emdee --help`. Auth commands: `login`, `logout`, `whoami`. Reads: `get-doc`, `get-summary`, `get-neighbors`, `get-context`, `search`, `read-doc-section`, `list-docs`, `list-summary-drift`, `list`, `drift-batch`. Writes: `patch-section`, `append-section`, `append-doc`, `patch-preamble`, `write-doc`, `write-doc-preview`, `create-child`, `add-association`, `move-doc`, `rename-doc`, `trash-doc`, `restore-doc`, `delete-doc`.

## MCP tools

The stdio server (`emdee mcp`) exposes 18 tools.

**Reads:**
- `list_docs` — every doc as `{path, title, summary}`. `format: "text"` returns paths only.
- `get_doc(path)` — full markdown, per-section `content_hash` for version-guarded patches.
- `get_summary(path)` — one doc's `{path, title, summary}`. Cheap.
- `get_neighbors(path)` — focal doc + 1-hop neighbourhood, categorised as parents / children / associated, each with the prose note attached to its wiki-link.
- `get_context(path, hops?, budget_tokens?)` — multi-hop neighbourhood within a token budget.
- `read_doc_section(path, section_id)` — one section without paying for the whole doc.
- `search(query, limit?)` — case-insensitive substring over titles, summaries, content.
- `list_summary_drift` — paths whose body has drifted since their summary was last authored.

**Writes (version-guarded where destructive):**
- `patch_section(path, section_id, body, expected_content_hash)` — replace one section; mismatched hash returns structured `version_conflict`.
- `append_section(path, section_id, body)` — safer than write_doc for incremental edits.
- `append_doc(path, body)` — append to end of doc (chronological notes, LOGS entries).
- `patch_preamble(path, body, expected_content_hash)` — replace the region between H1 and first H2.
- `write_doc(path, content)` — full-file replace (destructive; prefer section-scoped tools).
- `write_doc_preview(path, content)` — diff + list of sections that would be removed. Always call before `write_doc`.

**Atomic multi-side writes (keep the graph consistent):**
- `create_child(parent_path, title, body?, summary?)` — writes new doc with canonical scaffold AND patches parent's `## Parent of`. Collapses the 5-round-trip add-child flow into one call.
- `add_association(a_path, b_path, label?)` — patches both docs' `## Associated with` in one call. Hard-refuses hierarchy or sibling duplicates.
- `move_doc(path, new_parent_path)` — atomic reparent, three-side edge update.
- `rename_doc(old_path, new_title, new_path?)` — rewrites H1, moves the file, updates every `[[old_title]]` across the vault.
- `materialize_subgroup(source_path, subgroup_heading)` — promote an H3 subgroup inside `## Parent of` into a real intermediate parent doc.
- `split_doc(source_path, rewrite_source_content, extracts)` — atomically refactor a doc into concept nodes.

**Lifecycle:**
- `trash_doc(path)` / `restore_doc(path)` — sidecar-based soft delete, edges preserved for lossless restore.
- `delete_doc(path)` — permanent, no undo. Returns inbound edges + title conflicts.

## Design principles

1. **Markdown is the only source of truth.** No persisted index, no derived database, no parallel summaries.
2. **Same substrate, different lenses.** Renderer and MCP read the same files via the same indexer. Nothing the LLM sees is invisible to the human.
3. **Convention over schema.** Light structure — H1 + `> blockquote` summary + three relationship sections (`## Parent of`, `## Child of`, `## Associated with`). Rigid schemas add authoring friction; the LLM parses English natively.
4. **Single summary per doc.** The blockquote under the H1 is the routing decision for both humans and LLMs.
5. **Version-guarded writes.** Every destructive edit takes an `expected_content_hash`. Concurrent edits fail loudly with `version_conflict` instead of silent overwrites.

## What's in the repo

- `bin/emdee.js` — the `emdee` CLI (`init`, `list`, `drift-batch`, `mcp`, `start`, `serve-next`)
- `src/core/indexer.ts` — walks `docs/`, parses wiki-links and relationship sections, derives summaries, skips fenced code blocks
- `src/core/syncDocEdges.ts` — incremental edge sync backed by Supabase
- `src/mcp/server.ts` — stdio MCP server
- `src/lib/mcp/tools/` — the 18 tools listed above
- `src/lib/system-nodes.ts` — canonical content for the 5 virtual system nodes
- `src/lib/storage/` — `FilesystemStorage` (local mode) + `SupabaseStorage` (cloud mode) behind a single `VaultStorage` interface
- `app/` — Next.js App Router: renderer, `/api/index`, `/api/mcp`, OAuth pages for the claude.ai connector
- `supabase/migrations/` — schema (new files only, never edited in place)
- `templates/types/` — archetype scaffolds (`PROJECT`, `NOVEL`, `PERSON`, `HACKATHON`, `CONCEPT`) for future `emdee new <type>` commands
- `e2e/` — Playwright suite (MCP tools, auth, share RBAC, upload, CLI init)

## Conventions

Every doc follows the same shape:

```md
# TITLE

> One-line blockquote summary — this is what routing sees.

## Child of

* [[PARENT]]

## Parent of

* [[CHILD1]]
* [[CHILD2]]

## Associated with

* [[CROSS-TREE-NODE]] — optional prose about the link

## Notes

Freeform content.
```

Rules the lint enforces: one parent per doc; no self-loops; no associates that duplicate a hierarchy edge or sibling relationship; UPPERCASE filenames; lowercase folder names. `lint_doc(path)` surfaces violations; write tools accept `gate_on_warnings: ["code"]` to hard-block on specific ones.

## Cloud deployment

The repo also runs as a full Next.js web viewer at [emdee.tech](https://emdee.tech). Vercel auto-detects Next.js — set the standard Supabase + Clerk env vars, push to `main`, done. The `/api/mcp` endpoint speaks the HTTP MCP transport for claude.ai connectors; `/oauth/authorize` runs the PKCE flow for the "Connect to Claude.ai" panel.
