import type { DocIndex, DocNode } from "./indexer";

/**
 * Resolve the prev / next sibling of a focal doc by walking its first
 * declared parent's children. The parent's `## Parent of` bullet order is
 * the source of truth — that ordering drives prev/next sibling navigation
 * across the doc toolbar, the graph view, and the get_neighbors MCP tool.
 *
 * Fallback for asymmetric edges: when the parent's Parent-of list doesn't
 * include the focal (the child declared `Child of [[parent]]` but the
 * parent didn't reciprocate), we still want navigation to work. We
 * augment the declared list with any other doc whose first declared
 * parent matches the focal's first declared parent, sorted by title.
 * Declared siblings come first (in their bullet order) so the fix doesn't
 * change ordering for vaults with clean reciprocal edges. The lint_doc
 * tool surfaces the asymmetric edge as a separate signal so the user can
 * heal the underlying data when they want.
 *
 * Associated-with relationships never participate — siblings are purely a
 * taxonomic concept (same parent in the hierarchy).
 */
export function getPrevNextSiblings(
  index: DocIndex,
  focalPath: string
): { prevPath: string | null; nextPath: string | null } {
  const focalDoc = index.docs.find((d) => d.path === focalPath);
  if (!focalDoc) return { prevPath: null, nextPath: null };
  const primaryParent = focalDoc.parents[0];
  if (!primaryParent) return { prevPath: null, nextPath: null };

  const byTitle = new Map<string, DocNode>();
  for (const d of index.docs) byTitle.set(d.title.toLowerCase(), d);
  const parentDoc = byTitle.get(primaryParent.title.toLowerCase());
  if (!parentDoc) return { prevPath: null, nextPath: null };

  const declared: string[] = [];
  const declaredSet = new Set<string>();
  for (const link of parentDoc.children) {
    const child = byTitle.get(link.title.toLowerCase());
    if (!child || declaredSet.has(child.path)) continue;
    declared.push(child.path);
    declaredSet.add(child.path);
  }

  const inverse: DocNode[] = [];
  for (const d of index.docs) {
    if (declaredSet.has(d.path)) continue;
    const childPrimary = d.parents[0];
    if (!childPrimary) continue;
    const cp = byTitle.get(childPrimary.title.toLowerCase());
    if (cp?.path === parentDoc.path) inverse.push(d);
  }
  inverse.sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));

  const allSiblings = [...declared, ...inverse.map((d) => d.path)];
  const idx = allSiblings.indexOf(focalPath);
  if (idx === -1) return { prevPath: null, nextPath: null };
  return {
    prevPath: allSiblings[idx - 1] ?? null,
    nextPath: allSiblings[idx + 1] ?? null,
  };
}
