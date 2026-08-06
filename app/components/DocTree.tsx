"use client";
import { useEffect, useRef } from "react";
import type { DocIndex, DocNode } from "@/src/core/indexer";
import { SYSTEM_NODE_PATHS } from "@/src/lib/system-nodes";

export interface TreeNode {
  doc: DocNode;
  depth: number;
  children: TreeNode[];
}

export interface BuiltTree {
  roots: TreeNode[];
  orphans: TreeNode[];
}

/**
 * Build the hierarchical view of the vault from `index.edges`, splitting
 * top-level nodes into two buckets:
 *
 *   - `roots`   — system nodes (EMDEE / VAULT / SHARED / GRAVEYARD / IMAGES),
 *                 the vault entry, plus anything whose declared parent is
 *                 itself absent (structural roots).
 *   - `orphans` — everything else with no incoming hierarchy edge. These
 *                 are what SPRINT-120's `lint_orphans` flags: docs whose
 *                 `## Child of` never made it into `doc_edges`. Surfacing
 *                 them in a dedicated bucket keeps the tree stable and
 *                 makes the drift visible.
 *
 * The `roots` bucket is what the sidebar draws under the vault entry;
 * the `orphans` bucket is pinned at the top when non-empty.
 */
export function buildDocTree(index: DocIndex): BuiltTree {
  const childrenOf = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const e of index.edges) {
    if (e.kind !== "hierarchy") continue;
    const arr = childrenOf.get(e.from) ?? [];
    arr.push(e.to);
    childrenOf.set(e.from, arr);
    hasParent.add(e.to);
  }

  const byPath = new Map<string, DocNode>();
  for (const d of index.docs) byPath.set(d.path, d);

  // SPRINT-183: three-tier sort so `99-ARCHIVE`-style sinks to the bottom
  // of every sibling group. Tiers:
  //   0 — numeric-prefixed with num < 99 (sort by num asc, then title)
  //   1 — no numeric prefix (sort by title, alpha)
  //   2 — numeric-prefixed with num >= 99 (sort by num asc, then title)
  // Matches Edmund's convention of using 01/02/... for content and 99
  // for archive/deprecated.
  const sortKey = (title: string): [number, number, string] => {
    // SPRINT-184: sort on the LAST " — " segment so nested titles like
    // "03-PROJECTS — 99-ARCHIVE" key off "99-ARCHIVE" (not "03-PROJECTS")
    // and correctly sink to the bottom of the sibling group. The visible
    // label is already the stripped form; sort key must match.
    const segments = title.split(" — ");
    const leaf = segments[segments.length - 1];
    const m = leaf.match(/^(\d+)-/);
    if (!m) return [1, 0, leaf.toLowerCase()];
    const n = parseInt(m[1], 10);
    return [n >= 99 ? 2 : 0, n, leaf.toLowerCase()];
  };
  const sortPaths = (paths: string[]) =>
    [...paths].sort((a, b) => {
      const ka = sortKey(byPath.get(a)?.title ?? a);
      const kb = sortKey(byPath.get(b)?.title ?? b);
      if (ka[0] !== kb[0]) return ka[0] - kb[0];
      if (ka[1] !== kb[1]) return ka[1] - kb[1];
      return ka[2].localeCompare(kb[2]);
    });

  const visited = new Set<string>();
  const walk = (path: string, depth: number): TreeNode | null => {
    if (visited.has(path)) return null;
    visited.add(path);
    const doc = byPath.get(path);
    if (!doc) return null;
    const childPaths = sortPaths(childrenOf.get(path) ?? []);
    const children = childPaths
      .map((c) => walk(c, depth + 1))
      .filter((n): n is TreeNode => n !== null);
    return { doc, depth, children };
  };

  const parentless = index.docs.map((d) => d.path).filter((p) => !hasParent.has(p));

  // Anchor the tree at the vault entry + system nodes. Everything else
  // parentless is an orphan — a doc whose declared parent didn't resolve.
  const systemRoots = new Set<string>(SYSTEM_NODE_PATHS);
  const isTrueRoot = (p: string) => systemRoots.has(p) || p === index.entry;
  const rootPaths = sortPaths(parentless.filter(isTrueRoot));
  const orphanPaths = sortPaths(parentless.filter((p) => !isTrueRoot(p)));

  if (index.entry && rootPaths.includes(index.entry)) {
    const i = rootPaths.indexOf(index.entry);
    rootPaths.splice(i, 1);
    rootPaths.unshift(index.entry);
  }

  const roots: TreeNode[] = [];
  for (const p of rootPaths) {
    const node = walk(p, 0);
    if (node) roots.push(node);
  }
  const orphans: TreeNode[] = [];
  for (const p of orphanPaths) {
    const node = walk(p, 0);
    if (node) orphans.push(node);
  }
  // Any doc reachable neither from a system root nor an orphan (should be
  // rare — a cycle-only cluster) still surfaces as an orphan so we don't
  // lose it silently.
  for (const d of index.docs) {
    if (!visited.has(d.path)) {
      orphans.push({ doc: d, depth: 0, children: [] });
      visited.add(d.path);
    }
  }
  return { roots, orphans };
}

/**
 * Longest "X — " prefix shared by every title in a sibling group. Strips
 * noise like "ATLAS — " from ["ATLAS — BUILD", "ATLAS — CONTEXT"] so the
 * tree shows ["BUILD", "CONTEXT"].
 */
function siblingsCommonPrefix(titles: string[]): string | null {
  if (titles.length < 2) return null;
  const segs = titles.map((t) => t.split(" — "));
  let i = 0;
  while (true) {
    const first = segs[0][i];
    if (first === undefined) break;
    if (!segs.every((s) => s[i] === first)) break;
    i++;
  }
  if (i === 0) return null;
  return segs[0].slice(0, i).join(" — ") + " — ";
}

/**
 * Under a parent titled `03-DOUBLELEAD`, sibling titles like
 * `DOUBLELEAD — 01-CONTEXT` should shed the `DOUBLELEAD — ` prefix even
 * though the parent's title carries the numeric `03-`. The stripping
 * candidates are:
 *   - the sibling group's common prefix (existing)
 *   - the parent title verbatim + " — "
 *   - the parent title with any leading `\d+-` trimmed + " — "
 * Each candidate is tried longest-first; the first match wins.
 */
function displayTitle(title: string, parentTitle: string | null, siblingPrefix: string | null): string {
  const candidates: string[] = [];
  if (parentTitle) {
    const segments = parentTitle.split(" — ");
    for (let i = segments.length; i > 0; i--) {
      candidates.push(segments.slice(0, i).join(" — ") + " — ");
    }
    const numTrimmed = parentTitle.replace(/^\d+-/, "");
    if (numTrimmed !== parentTitle) candidates.push(numTrimmed + " — ");
  }
  if (siblingPrefix) candidates.push(siblingPrefix);
  candidates.sort((a, b) => b.length - a.length);
  for (const prefix of candidates) {
    if (title.startsWith(prefix)) return title.slice(prefix.length);
  }
  return title;
}

/**
 * Split a title into a dim numeric prefix (`01-`, `02-`) and the semantic
 * remainder. Keeps rows visually anchored on the meaningful name.
 */
function splitNumericPrefix(title: string): { prefix: string; body: string } {
  const m = title.match(/^(\d+-)(.+)$/);
  return m ? { prefix: m[1], body: m[2] } : { prefix: "", body: title };
}

interface DocTreeProps {
  nodes: TreeNode[];
  parentPath: string | null;
  parentTitle: string | null;
  activePath: string | null;
  collapsed: Set<string>;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
}

export function DocTree({ nodes, parentPath, parentTitle, activePath, collapsed, onSelect, onToggle }: DocTreeProps) {
  const activeRowRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!activeRowRef.current) return;
    activeRowRef.current.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activePath]);

  if (nodes.length === 0) return null;
  const isRoot = parentPath === null;
  const siblingPrefix = siblingsCommonPrefix(nodes.map((n) => n.doc.title));
  return (
    <ul className="doc-tree" data-root={isRoot}>
      {nodes.map((n) => {
        const hasChildren = n.children.length > 0;
        const isCollapsed = collapsed.has(n.doc.path);
        const isActive = n.doc.path === activePath;
        const shown = displayTitle(n.doc.title, parentTitle, siblingPrefix);
        const { prefix, body } = splitNumericPrefix(shown);
        return (
          <li key={n.doc.path} className="doc-tree-item">
            <div
              className="doc-tree-row-wrap"
              style={{ "--depth": n.depth } as React.CSSProperties}
            >
              <button
                className="doc-tree-chevron"
                onClick={() => hasChildren && onToggle(n.doc.path)}
                aria-label={hasChildren ? (isCollapsed ? "Expand" : "Collapse") : undefined}
                type="button"
                data-collapsed={isCollapsed}
                data-leaf={!hasChildren}
                tabIndex={hasChildren ? 0 : -1}
              >
                {hasChildren ? "›" : ""}
              </button>
              <button
                ref={isActive ? activeRowRef : undefined}
                className="doc-tree-row"
                onClick={() => {
                  onSelect(n.doc.path);
                  if (hasChildren && isCollapsed) onToggle(n.doc.path);
                }}
                data-active={isActive}
                type="button"
                title={n.doc.title}
              >
                {prefix && <span className="doc-tree-prefix">{prefix}</span>}
                <span className="doc-tree-label">{body}</span>
              </button>
            </div>
            {hasChildren && !isCollapsed && (
              <DocTree
                nodes={n.children}
                parentPath={n.doc.path}
                parentTitle={n.doc.title}
                activePath={activePath}
                collapsed={collapsed}
                onSelect={onSelect}
                onToggle={onToggle}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

interface OrphanBucketProps {
  orphans: TreeNode[];
  open: boolean;
  onToggle: () => void;
  activePath: string | null;
  collapsed: Set<string>;
  onSelect: (path: string) => void;
  onToggleNode: (path: string) => void;
}

/**
 * Pinned bucket at the top of the sidebar. Only rendered when there are
 * orphans; expanded on click. The count is the whole story — an operator
 * seeing "⚠ Orphaned · 3" knows something needs mending.
 */
export function OrphanBucket({
  orphans,
  open,
  onToggle,
  activePath,
  collapsed,
  onSelect,
  onToggleNode,
}: OrphanBucketProps) {
  if (orphans.length === 0) return null;
  return (
    <div className="doc-tree-orphans" data-open={open}>
      <button
        className="doc-tree-orphans-header"
        onClick={onToggle}
        type="button"
        aria-expanded={open}
      >
        <span className="doc-tree-orphans-icon" aria-hidden="true">⚠</span>
        <span className="doc-tree-orphans-label">Orphaned · {orphans.length}</span>
        <span className="doc-tree-orphans-chevron" data-open={open} aria-hidden="true">›</span>
      </button>
      {open && (
        <div className="doc-tree-orphans-body">
          <DocTree
            nodes={orphans}
            parentPath={null}
            parentTitle={null}
            activePath={activePath}
            collapsed={collapsed}
            onSelect={onSelect}
            onToggle={onToggleNode}
          />
        </div>
      )}
    </div>
  );
}
