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

function rowKey(r: { from_path: string; to_path: string; kind: string }): string {
  return `${r.kind}::${r.from_path}::${r.to_path}`;
}

function rowEqual(a: EdgeRow, b: EdgeRow): boolean {
  return a.label === b.label && a.position === b.position;
}

/**
 * Sync doc_edges rows touching `docPath` to match `newContent`.
 *
 * SPRINT-143 (egress fix): fetches (file_path, title) instead of content
 * for OTHER docs — a ~99% egress reduction on the write hot path. See
 * migration 20260726120000_add_vault_files_title.sql. Consequence:
 * we no longer re-derive OTHER docs' outgoing edges on every write.
 * Inbound edges to docPath from other docs' Parent-of / Associated
 * with are PRESERVED from the existing doc_edges rows (not recomputed
 * from other docs' content). Cross-doc edge freshness becomes
 * eventually-consistent unless the caller uses:
 *   - modern write tools (create_child / move_doc / add_association /
 *     rename_title — SPRINT-141b patches both sides atomically)
 *   - reconcile (namespace-wide re-derivation)
 * This matches the SPRINT-116 self-heal + reconcile design intent.
 */
export async function syncDocEdges(
  db: VaultDatabase,
  namespace: string,
  docPath: string,
  newContent: string,
): Promise<void> {
  // TITLES ONLY for resolver — no content payload. ~99% egress reduction.
  const rows = await db.listFiles(namespace, {
    select: "file_path, title",
    order: "file_path_asc",
  });

  const docs: DocMeta[] = rows.map((r) => ({
    path: r.file_path,
    // SPRINT-143: prefer the persisted title column; fall back to filename
    // slug if the doc has no H1 (rare — user-broken doc).
    title: (r.title as string | undefined | null) ?? filenameSlug(r.file_path),
    content: "", // OTHER docs contribute NO derived edges; only their titles matter (for the resolver).
  }));

  // Inject the doc being written WITH its new content so its outgoing
  // edges get derived. Delete = no content (fine — no from-edges).
  const filteredDocs = docs.filter((d) => d.path !== docPath);
  if (newContent) {
    filteredDocs.push({
      path: docPath,
      title: deriveTitle(docPath, newContent),
      content: newContent,
    });
  }

  // computeAllEdges will derive edges from docPath's newContent (and
  // system nodes) since OTHER docs have empty content.
  const all = computeAllEdges(namespace, injectSystemNodes(filteredDocs));
  const fromDocPathEdges: EdgeRow[] = [];
  for (const r of all.hierMap.values()) if (r.from_path === docPath) fromDocPathEdges.push(r);
  for (const r of all.assocMap.values()) if (r.from_path === docPath) fromDocPathEdges.push(r);

  // SPRINT-181: reciprocal hierarchy edges derived from docPath's own
  // `## Child of` bullets. Every such bullet produces an edge with
  // from_path=parent, to_path=docPath. Prior to this sprint these were
  // filtered out (only from_path === docPath survived), which meant a
  // per-doc reconcile of a child could NEVER heal an orphan — the
  // reciprocal edge only appeared when the PARENT was independently
  // synced. Root cause of every "sidebar orphan comes back after
  // reconcile" bug (see 2026-08-04 diagnosis in LEARNINGS). Now the
  // child is authoritative for its own parent link.
  const childOfInbound: EdgeRow[] = [];
  for (const r of all.hierMap.values()) {
    if (r.to_path === docPath && r.from_path !== docPath) childOfInbound.push(r);
  }

  // Preserve inbound edges to docPath from OTHER docs' assoc / parent-of
  // bullets that are already persisted (we don't re-derive them because
  // OTHER docs have empty content). If the same edge appears in both
  // `childOfInbound` and `inboundRows`, the persisted row wins so we
  // don't disturb the position field the parent recorded.
  const inboundRows = await db.getEdges(namespace, { to_path: docPath });
  const inboundFromOthers = inboundRows.filter((r) => r.from_path !== docPath);
  const inboundKeys = new Set(inboundFromOthers.map(rowKey));
  const newReciprocals = childOfInbound.filter((r) => !inboundKeys.has(rowKey(r)));

  const desiredRows: EdgeRow[] = [...fromDocPathEdges, ...inboundFromOthers, ...newReciprocals];

  // Short-circuit no-op writes.
  const curFrom = await db.getEdges(namespace, { from_path: docPath });
  const currentMap = new Map<string, EdgeRow>();
  for (const r of [...curFrom, ...inboundRows]) currentMap.set(rowKey(r), r);
  const desiredMap = new Map<string, EdgeRow>();
  for (const r of desiredRows) desiredMap.set(rowKey(r), r);
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
