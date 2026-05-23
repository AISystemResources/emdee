import type { DocIndex, DocNode } from "./indexer";
import { resolveWikiLink } from "./resolveLink";

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
 *
 * Wiki-link resolution defers to resolveWikiLink, so a bullet like
 * `[[DAY1]]` is disambiguated by path locality when multiple docs share
 * a title or slug.
 */
export function getPrevNextSiblings(
  index: DocIndex,
  focalPath: string
): { prevPath: string | null; nextPath: string | null } {
  const focalDoc = index.docs.find((d) => d.path === focalPath);
  if (!focalDoc) return { prevPath: null, nextPath: null };
  const primaryParent = focalDoc.parents[0];
  if (!primaryParent) return { prevPath: null, nextPath: null };

  const parentDoc = resolveWikiLink(index, primaryParent.title, focalPath);
  if (!parentDoc) return { prevPath: null, nextPath: null };

  const declared: string[] = [];
  const declaredSet = new Set<string>();
  for (const link of parentDoc.children) {
    const child = resolveWikiLink(index, link.title, parentDoc.path);
    if (!child || declaredSet.has(child.path)) continue;
    declared.push(child.path);
    declaredSet.add(child.path);
  }

  const inverse: DocNode[] = [];
  for (const d of index.docs) {
    if (declaredSet.has(d.path)) continue;
    const childPrimary = d.parents[0];
    if (!childPrimary) continue;
    const cp = resolveWikiLink(index, childPrimary.title, d.path);
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
