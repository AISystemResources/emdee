import { loadVaultIndex } from "./vault";
import type { DocIndex, DocNode, Link, ToolContext } from "./types";
import { getPrevNextSiblings } from "@/src/core/siblings";
import { resolveWikiLink } from "@/src/core/resolveLink";

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

interface NeighborRef { path: string; title: string; summary: string; note: string; }

function buildNeighbors(idx: DocIndex, focal: DocNode) {
  const byPath = new Map(idx.docs.map((d) => [d.path, d]));
  // Locality-aware resolver: bullets like `[[DAY1]]` are disambiguated
  // by the focal's path when two docs share the title or slug.
  const resolve = (t: string) => byPath.get(t) ?? resolveWikiLink(idx, t, focal.path);
  const refFor = (n: DocNode, note: string): NeighborRef => ({ path: n.path, title: n.title, summary: n.summary, note });

  const declaredParents = new Map<string, NeighborRef>();
  const declaredChildren = new Map<string, NeighborRef>();
  const declaredAssoc = new Map<string, NeighborRef>();
  for (const l of focal.parents) { const n = resolve(l.title); if (n) declaredParents.set(n.path, refFor(n, l.note)); }
  for (const l of focal.children) { const n = resolve(l.title); if (n) declaredChildren.set(n.path, refFor(n, l.note)); }
  for (const l of focal.associates) {
    const n = resolve(l.title);
    if (!n) continue;
    // Hierarchy beats associate — if the target is already a parent or
    // child of this focal, drop the assoc entry rather than double-listing.
    if (declaredParents.has(n.path) || declaredChildren.has(n.path)) continue;
    declaredAssoc.set(n.path, refFor(n, l.note));
  }

  const focalTitleLower = focal.title.toLowerCase();
  const matchesFocal = (l: Link) => l.title.toLowerCase() === focalTitleLower;
  for (const other of idx.docs) {
    if (other.path === focal.path) continue;
    const asChild = other.children.find(matchesFocal);
    if (asChild && !declaredParents.has(other.path)) declaredParents.set(other.path, refFor(other, asChild.note));
    const asParent = other.parents.find(matchesFocal);
    if (asParent && !declaredChildren.has(other.path)) declaredChildren.set(other.path, refFor(other, asParent.note));
    const asAssoc = other.associates.find(matchesFocal);
    if (asAssoc && !declaredAssoc.has(other.path)) declaredAssoc.set(other.path, refFor(other, asAssoc.note));
  }

  const declared = new Set([...declaredParents.keys(), ...declaredChildren.keys(), ...declaredAssoc.keys()]);
  const mentionedIn = idx.docs
    .filter((d) => d.path !== focal.path && !declared.has(d.path) && d.mentions.some((m) => m.toLowerCase() === focalTitleLower))
    .map((d) => ({ path: d.path, title: d.title, summary: d.summary }));

  // Prev/next sibling — shared helper. Uses the parent's `## Parent of`
  // bullet order, augmented with any other doc whose primary parent
  // matches focal's primary parent (catches asymmetric edges where the
  // child declared `Child of` but the parent didn't reciprocate).
  let prev_sibling: { path: string; title: string; summary: string } | null = null;
  let next_sibling: { path: string; title: string; summary: string } | null = null;
  const { prevPath, nextPath } = getPrevNextSiblings(idx, focal.path);
  if (prevPath) {
    const p = idx.docs.find((d) => d.path === prevPath);
    if (p) prev_sibling = { path: p.path, title: p.title, summary: p.summary };
  }
  if (nextPath) {
    const n = idx.docs.find((d) => d.path === nextPath);
    if (n) next_sibling = { path: n.path, title: n.title, summary: n.summary };
  }

  return {
    path: focal.path, title: focal.title, summary: focal.summary,
    parents: [...declaredParents.values()],
    children: [...declaredChildren.values()],
    associated: [...declaredAssoc.values()],
    mentioned_in: mentionedIn,
    prev_sibling,
    next_sibling,
  };
}

export async function getNeighbors(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const idx = await loadVaultIndex(ctx);
  const focal = idx.docs.find((d) => d.path === String(args.path));
  if (!focal) throw new Error(`no such doc: ${args.path}`);
  return json(buildNeighbors(idx, focal));
}
