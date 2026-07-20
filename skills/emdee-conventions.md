---
name: emdee-conventions
description: |
  Use whenever reading or writing an EMDEE vault. Covers the 5-node OS layer,
  doc shape (H1 + blockquote + relationship sections), edge discipline, CLI
  tool selection (atomic multi-side writes), and path conventions (UPPERCASE
  filenames, lowercase folders, hub-next-to-folder). Load this once and every
  subsequent vault operation lands correctly the first time.
---

# EMDEE conventions — always-loaded

You are working inside an Emdee vault. Every doc is plain markdown. Humans browse it through a Next.js renderer at [emdee.tech](https://emdee.tech); you read and write the same files through the `emdee` CLI. The vault is the source of truth — anything you say must trace back to a file the user wrote.

## The 5-node OS layer (virtual system nodes)

Every vault has exactly 5 canonical top-level docs plus one owner node. **These 5 are virtual** — they appear in every read (`emdee list`, `emdee get-doc`, etc.) without being on disk. Edit them and your version wins.

| Node | Purpose |
|---|---|
| `EMDEE` | Vault root — everything's anchor |
| `VAULT` | Private notes, projects, knowledge |
| `SHARED` | Content shared into this vault by others (cloud only) |
| `GRAVEYARD` | Archived / retired docs |
| `IMAGES` | Images and visual assets |
| `<YOUR-NAME>` | Personal subtree, one per user, uppercase |

## Doc shape (universal)

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

Rules the lint enforces (see `emdee lint-doc --path X` or `emdee patch-section --gate-on <code>`):

- **One parent per doc.** `## Child of` should have exactly one bullet. Multiple parents → demote secondaries to `## Associated with`.
- **No sibling associations.** Docs that share a parent are already related through it. `## Associated with` is for cross-tree links (project↔person, sprint↔learning).
- **Reciprocal edges.** If A's `## Parent of` lists `[[B]]`, B's `## Child of` must list `[[A]]`. Asymmetric edges fire `asymmetric_parent_edge` / `asymmetric_child_edge` warnings.
- **First wiki-link = declared edge.** `* [[TARGET]] — prose about the link`. The bullet's leading link is the edge; other links in the bullet are inline mentions only.
- **Sibling order is derived, never declared.** `emdee get-neighbors` returns `prev_sibling` / `next_sibling` computed from the parent's `## Parent of` order. Do NOT add `[[next-node]]` / `[[prev-node]]` bullets.

## Path conventions

- **Filenames UPPERCASE with HYPHENS:** `EDMUND.md`, `HANDSTAND-BALANCE-DRILL.md`. Never `edmund.md` or `handstandBalanceDrill.md`.
- **Folders lowercase:** `edmund/personal/philosophy/CLARITY-IS-POWER.md`. Not `edmund/Personal/PHILOSOPHY/`.
- **Hub sits next to folder.** `edmund/personal/PHILOSOPHY.md` (the hub) + `edmund/personal/philosophy/*` (the children). NOT `edmund/personal/philosophy/PHILOSOPHY.md`. The hub is a sibling of the folder it heads.

## Tool selection

Everything runs through the `emdee` CLI. `--remote` routes through the authenticated cloud vault at emdee.tech; omit for local mode.

```bash
emdee list --remote                    # top-level vault paths
emdee get-doc --path X --remote --full # doc body + per-section hashes
emdee search --query "keyword" --remote
```

Reads: `list`, `list-docs`, `get-doc`, `get-summary`, `get-neighbors`, `get-context`, `read-doc-section`, `search`, `list-summary-drift`, `drift-batch`, `lint-doc`, `get-image`.

Writes: `patch-section`, `patch-preamble`, `append-section`, `append-doc`, `create-child`, `add-association`, `move-doc`, `rename-doc`, `trash-doc`, `restore-doc`, `delete-doc`, `write-doc`, `write-doc-preview`, `distill-doc`, `materialize-subgroup`, `split-doc`.

For writes, always prefer the atomic multi-side variants over raw section patches:

| Instead of… | Use… |
|---|---|
| Two `patch-section` calls (child's Child of + parent's Parent of) | `emdee create-child` |
| Two `patch-section` calls on both docs' Associated with | `emdee add-association` |
| Three `patch-section` calls to reparent | `emdee move-doc` |
| Search+replace across every doc that references a title | `emdee rename-doc` |

The atomic variants take care of edge discipline (hard-refuse on sibling-assoc-redundant, would-duplicate-hierarchy) and rollback semantics.

For destructive full-file writes, always run `emdee write-doc-preview` first — `write-doc` silently drops any section not in the new payload.

## Version-guarded writes

Every destructive write (`patch-section`, `patch-preamble`, `move-doc`) requires `--expected-hash <hash>` from a prior read. Get it via `emdee get-doc --path X` (returns per-section content_hash + doc_content_hash). A stale hash returns `version_conflict` — refetch, reconcile, retry.

## HARD RULES you'll trip if you're not careful

1. **Any Supabase `.select()` reading > 1000 rows must paginate.** Use `.range(offset, offset + PAGE - 1)` in a loop. `.range()` alone doesn't lift the server-side 1000-row cap.
2. **`patch-section` on a `## Child of` requires patching the new parent's `## Parent of` in the same turn.** Otherwise you leave an asymmetric edge. Or just use `move-doc`.
3. **Any change to a tool's behaviour (CLI verb or MCP surface) requires an e2e spec in the same PR.** Test end-to-end via a real `ToolContext` + temp filesystem.
4. **Migrations touch `supabase/migrations/**` and are NEVER auto-merged.** Human review required.

## When in doubt

- `emdee lint-doc --path X --remote` — surface every warning code the doc trips
- `emdee get-doc --path X --remote` — see current state including per-section hashes
- Read the source of truth: `emdee get-doc --path "edmund/projects/emdee_os/LEARNINGS.md" --remote --full`
