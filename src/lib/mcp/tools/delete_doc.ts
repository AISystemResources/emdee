import { deleteVaultFile, loadVaultIndex, readVaultFile, validatePath } from "./vault";
import type { ToolContext } from "./types";
import { validateArgs } from "./validate_args";
import { guardDocContentHash } from "./version_guard";

const ARG_SPEC = { allowed: ["path", "expected_content_hash"], required: ["path"] } as const;

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/**
 * Permanently remove a doc from the vault. DESTRUCTIVE — there is no undo.
 *
 * Surfaces useful context before deletion:
 *  - inbound_edges: docs that link TO this one (their wiki-links will break)
 *  - title_conflicts: other files sharing this doc's title (the deletion
 *    will resolve a title→path ambiguity in the indexer)
 *
 * The caller is expected to fix dangling references with patch_section
 * afterwards if inbound_edges is non-empty.
 */
export async function deleteDoc(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const argErr = validateArgs(args, ARG_SPEC);
  if (argErr) return json(argErr);
  const rel = String(args.path);
  validatePath(rel);

  const content = await readVaultFile(ctx, rel);
  if (content === null) {
    return { content: [{ type: "text", text: `not found: ${rel}` }] };
  }
  const expected = args.expected_content_hash !== undefined ? String(args.expected_content_hash) : undefined;
  const conflict = await guardDocContentHash(ctx, rel, expected);
  if (conflict) return json(conflict);

  const index = await loadVaultIndex(ctx);
  const target = index.docs.find((d) => d.path === rel);
  const targetTitleLc = target?.title.toLowerCase();

  const inbound = target
    ? index.edges
        .filter((e) => e.to === rel && e.from !== rel)
        .map((e) => ({ from: e.from, kind: e.kind }))
    : [];

  const titleConflicts = targetTitleLc
    ? index.docs
        .filter((d) => d.path !== rel && d.title.toLowerCase() === targetTitleLc)
        .map((d) => d.path)
    : [];

  await deleteVaultFile(ctx, rel);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            deleted: rel,
            title: target?.title ?? null,
            inbound_edges: inbound,
            title_conflicts: titleConflicts,
          },
          null,
          2
        ),
      },
    ],
  };
}
