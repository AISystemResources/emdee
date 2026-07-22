import { loadVaultIndex, writeVaultFile } from "./vault";
import { validateArgs } from "./validate_args";
import type { ToolContext } from "./types";

// SPRINT-116: bulk-safe wiki-link rewrite.
//
// Motivation: rename_doc only updates references when the whole doc is
// being renamed. In practice, migrations often need to rewrite refs to a
// title without touching the underlying doc (e.g., the doc was already
// renamed manually, and now references need to catch up). Doing this
// today means orchestrating per-doc get→replace→write from the client,
// which hits doc_edges constraint drift at bulk scale.
//
// rename_title is a REFERENCE UPDATER. It does NOT touch the doc that
// owns the title — that's rename_doc's job. It finds every wiki-link
// `[[old]]` or `[[old|alias]]` across the vault and rewrites to `[[new]]`.
// Aliases are preserved.
//
// Composes with SPRINT-116's syncDocEdges self-heal so per-doc writes
// don't cascade into constraint violations mid-batch.

const ARG_SPEC = {
  allowed: ["old_title", "new_title"],
  required: ["old_title", "new_title"],
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rewriteWikiLinks(content: string, oldTitle: string, newTitle: string): { content: string; changed: boolean } {
  if (oldTitle.toLowerCase() === newTitle.toLowerCase()) return { content, changed: false };
  const re = new RegExp(`\\[\\[${escapeRegex(oldTitle)}(\\|[^\\]]+)?\\]\\]`, "gi");
  let changed = false;
  const next = content.replace(re, (_match, alias: string | undefined) => {
    changed = true;
    return `[[${newTitle}${alias ?? ""}]]`;
  });
  return { content: next, changed };
}

function json(v: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] };
}

export async function renameTitle(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const argErr = validateArgs(args, ARG_SPEC);
  if (argErr) return json(argErr);

  const oldTitle = String(args.old_title ?? "").trim();
  const newTitle = String(args.new_title ?? "").trim();
  if (!oldTitle) return json({ error: "old_title_required" });
  if (!newTitle) return json({ error: "new_title_required" });
  if (oldTitle.toLowerCase() === newTitle.toLowerCase()) {
    return json({ error: "titles_identical", hint: "old_title and new_title are the same (case-insensitive); nothing to do" });
  }

  const index = await loadVaultIndex(ctx);

  // Optional collision check: warn if newTitle is already used by a doc.
  // Not an error — the caller may know they're deliberately re-pointing
  // refs at an existing doc — but include in the response for visibility.
  const collision = index.docs.find((d) => d.title.toLowerCase() === newTitle.toLowerCase());

  let docsRewritten = 0;
  const rewrittenPaths: string[] = [];
  for (const d of index.docs) {
    const result = rewriteWikiLinks(d.content, oldTitle, newTitle);
    if (!result.changed) continue;
    await writeVaultFile(ctx, d.path, result.content);
    docsRewritten++;
    rewrittenPaths.push(d.path);
  }

  return json({
    ok: true,
    old_title: oldTitle,
    new_title: newTitle,
    docs_rewritten: docsRewritten,
    paths: rewrittenPaths,
    new_title_owner: collision?.path ?? null,
  });
}
