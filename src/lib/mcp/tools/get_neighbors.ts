import { buildIndex, type DocIndex, type DocNode, type Link } from "../../../core/indexer.js";
import type { ToolContext } from "./types.js";

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

interface NeighborRef {
  path: string;
  title: string;
  summary: string;
  note: string;
}

function buildNeighbors(idx: DocIndex, focal: DocNode) {
  const byPath = new Map(idx.docs.map((d) => [d.path, d]));
  const byTitle = new Map<string, DocNode>();
  for (const d of idx.docs) byTitle.set(d.title.toLowerCase(), d);

  const resolve = (titleOrPath: string): DocNode | undefined =>
    byPath.get(titleOrPath) ?? byTitle.get(titleOrPath.toLowerCase());

  const refFor = (n: DocNode, note: string): NeighborRef => ({
    path: n.path,
    title: n.title,
    summary: n.summary,
    note,
  });

  const declaredParents = new Map<string, NeighborRef>();
  for (const l of focal.parents) {
    const n = resolve(l.title);
    if (n) declaredParents.set(n.path, refFor(n, l.note));
  }
  const declaredChildren = new Map<string, NeighborRef>();
  for (const l of focal.children) {
    const n = resolve(l.title);
    if (n) declaredChildren.set(n.path, refFor(n, l.note));
  }
  const declaredAssoc = new Map<string, NeighborRef>();
  for (const l of focal.associates) {
    const n = resolve(l.title);
    if (n) declaredAssoc.set(n.path, refFor(n, l.note));
  }

  const focalTitleLower = focal.title.toLowerCase();
  const matchesFocal = (l: Link) => l.title.toLowerCase() === focalTitleLower;

  for (const other of idx.docs) {
    if (other.path === focal.path) continue;
    const asChild = other.children.find(matchesFocal);
    if (asChild && !declaredParents.has(other.path)) {
      declaredParents.set(other.path, refFor(other, asChild.note));
    }
    const asParent = other.parents.find(matchesFocal);
    if (asParent && !declaredChildren.has(other.path)) {
      declaredChildren.set(other.path, refFor(other, asParent.note));
    }
    const asAssoc = other.associates.find(matchesFocal);
    if (asAssoc && !declaredAssoc.has(other.path)) {
      declaredAssoc.set(other.path, refFor(other, asAssoc.note));
    }
  }

  const declared = new Set<string>([
    ...declaredParents.keys(),
    ...declaredChildren.keys(),
    ...declaredAssoc.keys(),
  ]);
  const mentionedIn: { path: string; title: string; summary: string }[] = [];
  for (const other of idx.docs) {
    if (other.path === focal.path) continue;
    if (declared.has(other.path)) continue;
    if (other.mentions.some((m) => m.toLowerCase() === focalTitleLower)) {
      mentionedIn.push({ path: other.path, title: other.title, summary: other.summary });
    }
  }

  return {
    path: focal.path,
    title: focal.title,
    summary: focal.summary,
    parents: [...declaredParents.values()],
    children: [...declaredChildren.values()],
    associated: [...declaredAssoc.values()],
    mentioned_in: mentionedIn,
  };
}

export async function getNeighbors(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const idx = await buildIndex(ctx.docsDir);
  const focal = idx.docs.find((d) => d.path === String(args.path));
  if (!focal) throw new Error(`no such doc: ${args.path}`);
  return json(buildNeighbors(idx, focal));
}
