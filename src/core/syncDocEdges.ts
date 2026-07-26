// SPRINT-018 Phase 2: incremental doc_edges sync triggered by the
// storage write hook. Given the new content of one doc, compute the
// desired set of edge rows that touch this doc (outgoing AND inbound,
// since editing a child's `## Child of` can flip a hierarchy edge that
// lives as a row on the parent) and diff against what's currently in
// the table — minimum-churn DELETE/UPSERT.
//
// Suppression mirrors src/core/indexer.ts: hierarchy first; then assocs
// drop pairs that are already linked hierarchically or share a parent
// (siblings). Resolution mirrors src/core/resolveLink.ts → pickByLocality.
//
// SPRINT-139 chunk B: these functions now take VaultDatabase instead of
// SupabaseClient. Pagination + atomic-RPC discipline moves into the
// SupabasePostgresDatabase impl. Callers must supply a VaultDatabase.

import { parseEdges } from "./parseEdges";
import { pickByLocality, filenameSlug } from "./resolveLink";
import { SYSTEM_NODES, missingSystemNodeFiles } from "../lib/system-nodes";
import type { VaultDatabase, EdgeRow } from "../lib/database/types";

interface DocMeta {
  path: string;
  title: string;
  content: string;
}

// Append virtual system nodes to a doc set so [[EMDEE]] / [[VAULT]] etc.
// resolve in the edge resolver even when those nodes have no stored file.
function injectSystemNodes(docs: DocMeta[]): DocMeta[] {
  const extras: DocMeta[] = missingSystemNodeFiles(docs.map((d) => d.path)).map((f) => {
    const node = SYSTEM_NODES.find((n) => n.path === f.path)!;
    return { path: f.path, title: node.title, content: f.content };
  });
  return extras.length > 0 ? [...docs, ...extras] : docs;
}

function deriveTitle(rel: string, content: string): string {
  const m = content.match(/^#\s+(.+)$/m);
  if (m) return m[1].trim();
  const last = rel.split("/").pop() ?? rel;
  return last.replace(/\.md$/i, "");
}

/**
 * Build a title-or-slug resolver across the namespace. Same precedence
 * order as buildIndexFromContents: H1 title first, filename slug as
 * fallback; ambiguous matches broken by pickByLocality(fromPath).
 */
function makeResolver(docs: DocMeta[]) {
  const titleMap = new Map<string, string[]>();
  const slugMap = new Map<string, string[]>();
  for (const d of docs) {
    const tKey = d.title.toLowerCase();
    const sKey = filenameSlug(d.path).toLowerCase();
    const tArr = titleMap.get(tKey) ?? [];
    tArr.push(d.path);
    titleMap.set(tKey, tArr);
    const sArr = slugMap.get(sKey) ?? [];
    sArr.push(d.path);
    slugMap.set(sKey, sArr);
  }
  return (target: string, fromPath: string): string | undefined => {
    const lower = target.toLowerCase();
    const titles = titleMap.get(lower);
    if (titles && titles.length > 0) {
      return titles.length === 1 ? titles[0] : pickByLocality(titles.map((path) => ({ path })), fromPath).path;
    }
    const slugs = slugMap.get(lower);
    if (slugs && slugs.length > 0) {
      return slugs.length === 1 ? slugs[0] : pickByLocality(slugs.map((path) => ({ path })), fromPath).path;
    }
    return undefined;
  };
}

interface DesiredEdges {
  hierMap: Map<string, EdgeRow>;
  assocMap: Map<string, EdgeRow>;
  duplicateParents: Array<{ child: string; kept: string; dropped: string[] }>;
}

function computeAllEdges(namespace: string, docs: DocMeta[]): DesiredEdges {
  const resolve = makeResolver(docs);
  const hierMap = new Map<string, EdgeRow>();

  for (const d of docs) {
    const bullets = parseEdges(d.content);
    let pos = 0;
    for (const b of bullets) {
      if (b.kind !== "parent_of") continue;
      const target = resolve(b.target, d.path);
      if (!target || target === d.path) continue;
      hierMap.set(`${d.path}::${target}`, {
        namespace,
        from_path: d.path,
        to_path: target,
        kind: "hierarchy",
        label: b.label,
        position: pos++,
      });
    }
  }
  for (const d of docs) {
    const bullets = parseEdges(d.content);
    for (const b of bullets) {
      if (b.kind !== "child_of") continue;
      const target = resolve(b.target, d.path);
      if (!target || target === d.path) continue;
      const key = `${target}::${d.path}`;
      if (hierMap.has(key)) continue;
      hierMap.set(key, {
        namespace,
        from_path: target,
        to_path: d.path,
        kind: "hierarchy",
        label: b.label,
        position: 9999,
      });
    }
  }

  // Enforce doc_edges_one_parent (SPRINT-117): closer parent by locality wins.
  const byChild = new Map<string, EdgeRow[]>();
  for (const r of hierMap.values()) {
    const arr = byChild.get(r.to_path) ?? [];
    arr.push(r);
    byChild.set(r.to_path, arr);
  }
  const duplicateParents: Array<{ child: string; kept: string; dropped: string[] }> = [];
  for (const [toPath, candidates] of byChild) {
    if (candidates.length <= 1) continue;
    const winner = pickByLocality(candidates.map((r) => ({ path: r.from_path })), toPath);
    const dropped: string[] = [];
    for (const r of candidates) {
      if (r.from_path === winner.path) continue;
      hierMap.delete(`${r.from_path}::${toPath}`);
      dropped.push(r.from_path);
    }
    duplicateParents.push({ child: toPath, kept: winner.path, dropped });
  }

  const hierPairs = new Set<string>();
  const parentsOf = new Map<string, Set<string>>();
  for (const r of hierMap.values()) {
    const [lo, hi] = r.from_path < r.to_path ? [r.from_path, r.to_path] : [r.to_path, r.from_path];
    hierPairs.add(`${lo}::${hi}`);
    const set = parentsOf.get(r.to_path) ?? new Set<string>();
    set.add(r.from_path);
    parentsOf.set(r.to_path, set);
  }
  const shareParent = (a: string, b: string) => {
    const pa = parentsOf.get(a);
    const pb = parentsOf.get(b);
    if (!pa || !pb) return false;
    for (const p of pa) if (pb.has(p)) return true;
    return false;
  };

  interface AssocPair { a: string; b: string; label: string | null; position: number; }
  const assocPairs = new Map<string, AssocPair>();
  for (const d of docs) {
    const bullets = parseEdges(d.content);
    let pos = 0;
    for (const b of bullets) {
      if (b.kind !== "associated") continue;
      const target = resolve(b.target, d.path);
      if (!target || target === d.path) continue;
      const [lo, hi] = d.path < target ? [d.path, target] : [target, d.path];
      const key = `${lo}::${hi}`;
      if (hierPairs.has(key)) continue;
      if (shareParent(d.path, target)) continue;
      if (!assocPairs.has(key)) {
        assocPairs.set(key, { a: d.path, b: target, label: b.label, position: pos });
        pos++;
      }
    }
  }

  const assocMap = new Map<string, EdgeRow>();
  for (const { a, b, label, position } of assocPairs.values()) {
    assocMap.set(`${a}::${b}`, { namespace, from_path: a, to_path: b, kind: "assoc", label, position });
    assocMap.set(`${b}::${a}`, { namespace, from_path: b, to_path: a, kind: "assoc", label, position });
  }

  return { hierMap, assocMap, duplicateParents };
}

function computeDesired(namespace: string, docs: DocMeta[], affectedPath: string): DesiredEdges {
  const all = computeAllEdges(namespace, docs);
  const filterTouching = <T extends EdgeRow>(map: Map<string, T>) => {
    const out = new Map<string, T>();
    for (const [k, r] of map) {
      if (r.from_path === affectedPath || r.to_path === affectedPath) out.set(k, r);
    }
    return out;
  };
  return {
    hierMap: filterTouching(all.hierMap),
    assocMap: filterTouching(all.assocMap),
    duplicateParents: all.duplicateParents.filter(
      (d) => d.child === affectedPath || d.kept === affectedPath || d.dropped.includes(affectedPath),
    ),
  };
}

function rowKey(r: { from_path: string; to_path: string; kind: string }): string {
  return `${r.kind}::${r.from_path}::${r.to_path}`;
}

function rowEqual(a: EdgeRow, b: EdgeRow): boolean {
  return a.label === b.label && a.position === b.position;
}

/**
 * Sync doc_edges rows touching `docPath` to match `newContent`.
 * SPRINT-139: takes VaultDatabase; pagination + atomic RPC live in the impl.
 */
export async function syncDocEdges(
  db: VaultDatabase,
  namespace: string,
  docPath: string,
  newContent: string,
): Promise<void> {
  const rows = await db.listFiles(namespace, {
    select: "file_path, content",
    order: "file_path_asc",
  });

  const docs: DocMeta[] = rows.map((r) => {
    const content = r.content ?? "";
    return { path: r.file_path, title: deriveTitle(r.file_path, content), content };
  });

  const filteredDocs = docs.filter((d) => d.path !== docPath || newContent !== "");
  if (newContent) {
    const existing = filteredDocs.find((d) => d.path === docPath);
    if (existing) {
      existing.content = newContent;
      existing.title = deriveTitle(docPath, newContent);
    } else {
      filteredDocs.push({ path: docPath, title: deriveTitle(docPath, newContent), content: newContent });
    }
  }

  const desired = computeDesired(namespace, injectSystemNodes(filteredDocs), docPath);
  const desiredRows: EdgeRow[] = [...desired.hierMap.values(), ...desired.assocMap.values()];

  // Fetch current rows touching docPath (from + to).
  const curFrom = await db.getEdges(namespace, { from_path: docPath });
  const curTo = await db.getEdges(namespace, { to_path: docPath });

  const currentMap = new Map<string, EdgeRow>();
  for (const r of [...curFrom, ...curTo]) currentMap.set(rowKey(r), r);

  const desiredMap = new Map<string, EdgeRow>();
  for (const r of desiredRows) desiredMap.set(rowKey(r), r);

  // Short-circuit no-op writes to avoid the atomic RPC round trip.
  if (currentMap.size === desiredMap.size) {
    let identical = true;
    for (const [k, r] of desiredMap) {
      const cur = currentMap.get(k);
      if (!cur || !rowEqual(cur, r)) { identical = false; break; }
    }
    if (identical) return;
  }

  await db.syncEdgesAtomic(namespace, docPath, desiredRows);
}

/**
 * Wipe and rebuild every doc_edges row for `namespace` from the current
 * vault_files snapshot. Idempotent.
 */
export async function backfillNamespace(
  db: VaultDatabase,
  namespace: string,
): Promise<{
  docs: number;
  rows: number;
  duplicate_parents: Array<{ child: string; kept: string; dropped: string[] }>;
}> {
  const rows = await db.listFiles(namespace, {
    select: "file_path, content",
    order: "file_path_asc",
  });
  const docs: DocMeta[] = rows.map((r) => {
    const content = r.content ?? "";
    return { path: r.file_path, title: deriveTitle(r.file_path, content), content };
  });

  const all = computeAllEdges(namespace, injectSystemNodes(docs));
  const edgeRows: EdgeRow[] = [...all.hierMap.values(), ...all.assocMap.values()];

  await db.clearEdges(namespace);
  await db.insertEdges(edgeRows);

  return { docs: docs.length, rows: edgeRows.length, duplicate_parents: all.duplicateParents };
}

/**
 * Delete every edge touching `docPath` in the namespace.
 */
export async function deleteDocEdges(
  db: VaultDatabase,
  namespace: string,
  docPath: string,
): Promise<void> {
  await db.deleteEdges(namespace, docPath);
}
