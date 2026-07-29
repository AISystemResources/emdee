import { loadVaultIndex } from "./vault";
import type { DocIndex, DocNode, Link, ToolContext } from "./types";
import { getPrevNextSiblings } from "../../../core/siblings";
import { resolveWikiLink } from "../../../core/resolveLink";

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

interface NeighborRef { path: string; title: string; summary: string; note: string; }

// SPRINT-172: bounded ego graph (focal + 1-hop). Cytoscape.js-compatible
// element list. Returned inline so Claude can render an Artifact from
// data it already has in-context — claude.ai's Artifact security model
// refuses to embed external URLs (see LEARNINGS).
interface GraphElement { data: { id?: string; source?: string; target?: string; label: string; kind?: "focal" | "parent" | "child" | "associated" } }

function buildGraphElements(focal: DocNode, parents: NeighborRef[], children: NeighborRef[], associated: NeighborRef[]): GraphElement[] {
  const els: GraphElement[] = [{ data: { id: focal.path, label: focal.title, kind: "focal" } }];
  const seen = new Set<string>([focal.path]);
  const push = (n: NeighborRef, kind: "parent" | "child" | "associated", edgeLabel: string) => {
    if (seen.has(n.path)) return;
    seen.add(n.path);
    els.push({ data: { id: n.path, label: n.title, kind } });
    els.push({ data: { source: focal.path, target: n.path, label: edgeLabel } });
  };
  for (const p of parents) push(p, "parent", "child of");
  for (const c of children) push(c, "child", "parent of");
  for (const a of associated) push(a, "associated", "associated");
  return els;
}

function buildNeighbors(idx: DocIndex, focal: DocNode) {
  const byPath = new Map(idx.docs.map((d) => [d.path, d]));
  const resolve = (t: string) => byPath.get(t) ?? resolveWikiLink(idx, t, focal.path);
  const refFor = (n: DocNode, note: string): NeighborRef => ({ path: n.path, title: n.title, summary: n.summary, note });

  const declaredParents = new Map<string, NeighborRef>();
  const declaredChildren = new Map<string, NeighborRef>();
  const declaredAssoc = new Map<string, NeighborRef>();
  for (const l of focal.parents) { const n = resolve(l.title); if (n) declaredParents.set(n.path, refFor(n, l.note)); }
  for (const l of focal.children) { const n = resolve(l.title); if (n) declaredChildren.set(n.path, refFor(n, l.note)); }
  const focalParentPaths = new Set(
    focal.parents
      .map((l) => resolve(l.title)?.path)
      .filter((p): p is string => !!p)
  );
  for (const l of focal.associates) {
    const n = resolve(l.title);
    if (!n) continue;
    if (declaredParents.has(n.path) || declaredChildren.has(n.path)) continue;
    if (focalParentPaths.size > 0) {
      const candidateParentPaths = n.parents
        .map((pl) => resolve(pl.title)?.path)
        .filter((p): p is string => !!p);
      if (candidateParentPaths.some((p) => focalParentPaths.has(p))) continue;
    }
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

  const parents = [...declaredParents.values()];
  const children = [...declaredChildren.values()];
  const associated = [...declaredAssoc.values()];

  return {
    path: focal.path, title: focal.title, summary: focal.summary,
    parents,
    children,
    associated,
    mentioned_in: mentionedIn,
    prev_sibling,
    next_sibling,
    graph: { elements: buildGraphElements(focal, parents, children, associated) },
  };
}

export async function getNeighbors(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const idx = await loadVaultIndex(ctx);
  const focal = idx.docs.find((d) => d.path === String(args.path));
  if (!focal) throw new Error(`no such doc: ${args.path}`);
  return json(buildNeighbors(idx, focal));
}
