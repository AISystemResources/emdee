import { validatePath, readVaultFile, loadVaultIndex } from "./vault";
import { lintDocContent, type LintVaultContext, type LintDocInfo } from "./lint";
import { resolveWikiLink } from "../../../core/resolveLink";
import type { DocIndex } from "../../../core/indexer";
import type { ToolContext } from "./types";

// Re-exported for callsites in other tools that need the same context
// shape — keeps lint_doc the single authority for the resolver wiring.
export type { LintVaultContext } from "./lint";

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/**
 * Build a LintVaultContext for a given doc using a pre-loaded vault
 * index. Extracted so the lint gate, add_association, and any other
 * caller that already has the index can reuse the resolveTarget closure
 * without re-walking the index. The closure resolves wiki-link targets
 * through the locality-aware resolveWikiLink — same behaviour the
 * lintDoc tool uses.
 */
export function buildLintVaultContext(index: DocIndex, selfPath: string): LintVaultContext {
  const docInfoByPath = new Map<string, LintDocInfo>();
  for (const d of index.docs) {
    const declaredParents = d.parents
      .map((l) => resolveWikiLink(index, l.title, d.path)?.path)
      .filter((p): p is string => !!p);
    const declaredChildren = d.children
      .map((l) => resolveWikiLink(index, l.title, d.path)?.path)
      .filter((p): p is string => !!p);
    docInfoByPath.set(d.path, {
      path: d.path,
      title: d.title,
      declaredParents,
      declaredChildren,
    });
  }
  const selfInfo = docInfoByPath.get(selfPath);
  const selfDeclaredParents = selfInfo?.declaredParents ?? [];
  const resolveTarget = (target: string): LintDocInfo | null => {
    const resolved = resolveWikiLink(index, target, selfPath);
    if (!resolved) return null;
    return docInfoByPath.get(resolved.path) ?? null;
  };
  return { selfPath, selfDeclaredParents, resolveTarget };
}

/**
 * Audit a doc for known quality defects. Returns warnings + structural info.
 * Never throws on a "bad" doc — lint is a signal, not a gate.
 *
 * Single-doc rules (missing preamble, undeclared inline mentions,
 * multi-parent, distillation candidates) and cross-doc rules (asymmetric
 * Parent/Child edges, sibling-assoc redundancy) both run here — this
 * tool loads the full vault index, so the cross-doc checks have the
 * context they need. The post-write fast paths in write_doc and
 * patch_section skip the cross-doc rules to stay cheap.
 *
 * Cross-doc resolution goes through the locality-aware resolveWikiLink,
 * so a `[[GBI-DAY3]]` link resolves via slug match to the file named
 * `GBI-DAY3.md` even though its H1 title is `GBI — DAY3`. A title-only
 * map (the previous implementation) would have left every such link
 * unresolved and falsely flagged the edges as asymmetric.
 */
export async function lintDoc(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const rel = String(args.path);
  validatePath(rel);
  const content = await readVaultFile(ctx, rel);
  if (content === null) return json({ error: "doc_not_found", path: rel });

  const index = await loadVaultIndex(ctx);
  const lintCtx = buildLintVaultContext(index, rel);
  const result = lintDocContent(content, lintCtx);
  return json({ path: rel, ...result });
}
