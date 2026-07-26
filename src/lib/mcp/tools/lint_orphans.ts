import { loadVaultIndex, readVaultFile } from "./vault";
import { syncDocEdges, deleteDocEdges } from "../../../core/syncDocEdges";
import { resolveWikiLink } from "../../../core/resolveLink";
import { ctxNamespace, ensureLocalIndex } from "./context";
import { SYSTEM_NODES } from "../../system-nodes";
import type { ToolContext } from "./types";

// SPRINT-120: detect + auto-fix orphan nodes (docs with no incoming
// hierarchy edge in doc_edges). Two failure modes surface as orphans:
//
// - data_layer_drift: markdown correctly declares `## Child of [[X]]`
//   AND X resolves to a real doc, but doc_edges is missing the row.
//   Cause: prior sync failure, pre-SPRINT-119 pagination bug, etc.
//   Auto-fixable via per-doc reconcile.
//
// - markdown_drift: `## Child of` wiki-link doesn't resolve (typo,
//   renamed parent, deleted parent). Not auto-fixable; report with
//   a fuzzy-match suggestion so the operator can `patch-section`.
//
// - structural_orphan: no `## Child of` bullets at all. May be
//   intentional (a root) or an oversight. Report separately so the
//   operator can decide.
//
// Cloud-only — local mode has no doc_edges (indexer rebuilds every read).

interface OrphanReport {
  path: string;
  title: string;
  kind: "data_layer_drift" | "markdown_drift" | "structural_orphan";
  declared_parents: string[];
  unresolved_parents?: string[];
  suggestion?: string;
}

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

// Fuzzy-match against titles: longest common prefix (case-insensitive).
// Cheap heuristic that catches the two most common cases (rename with a
// prefix/suffix change, minor typo).
function suggestSimilar(target: string, allTitles: string[]): string | undefined {
  const t = target.toLowerCase();
  let best: { title: string; score: number } | null = null;
  for (const title of allTitles) {
    const lt = title.toLowerCase();
    if (lt === t) continue;
    let common = 0;
    const min = Math.min(t.length, lt.length);
    for (let i = 0; i < min; i++) {
      if (t[i] === lt[i]) common++;
      else break;
    }
    if (common < 4) continue;
    if (!best || common > best.score) best = { title, score: common };
  }
  return best?.title;
}

export async function lintOrphans(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const fix = args.fix === true;
  await ensureLocalIndex(ctx);
  const db = ctx.db;
  const namespace = ctxNamespace(ctx);

  // SPRINT-139: read hierarchy edges via VaultDatabase.getEdges (handles
  // pagination + ordering internally per SPRINT-117 / SPRINT-119).
  const hierEdges = await db.getEdges(namespace, { kind: "hierarchy" });
  const inboundHier = new Set(hierEdges.map((e) => e.to_path));

  // Build the same index the indexer would build — this is our reference
  // for what edges SHOULD exist per markdown truth.
  const index = await loadVaultIndex(ctx);
  const systemPaths = new Set(SYSTEM_NODES.map((n) => n.path));
  const allTitles = index.docs.map((d) => d.title);

  const orphans: OrphanReport[] = [];
  const fixCandidates: string[] = [];

  for (const doc of index.docs) {
    if (systemPaths.has(doc.path)) continue;
    if (inboundHier.has(doc.path)) continue;

    const declaredParents = doc.parents.map((l) => l.title);

    if (declaredParents.length === 0) {
      orphans.push({
        path: doc.path,
        title: doc.title,
        kind: "structural_orphan",
        declared_parents: [],
      });
      continue;
    }

    const unresolved: string[] = [];
    let anyResolved = false;
    for (const parentLink of declaredParents) {
      const resolved = resolveWikiLink(index, parentLink, doc.path);
      if (resolved) {
        anyResolved = true;
      } else {
        unresolved.push(parentLink);
      }
    }

    if (anyResolved) {
      // Markdown declares a parent that resolves, yet doc_edges lacks the
      // edge → data-layer drift. Auto-fixable.
      orphans.push({
        path: doc.path,
        title: doc.title,
        kind: "data_layer_drift",
        declared_parents: declaredParents,
      });
      fixCandidates.push(doc.path);
    } else {
      const suggestion = suggestSimilar(unresolved[0], allTitles);
      orphans.push({
        path: doc.path,
        title: doc.title,
        kind: "markdown_drift",
        declared_parents: declaredParents,
        unresolved_parents: unresolved,
        ...(suggestion ? { suggestion: `nearest title: [[${suggestion}]]` } : {}),
      });
    }
  }

  const byKind = {
    data_layer_drift: orphans.filter((o) => o.kind === "data_layer_drift").length,
    markdown_drift: orphans.filter((o) => o.kind === "markdown_drift").length,
    structural_orphan: orphans.filter((o) => o.kind === "structural_orphan").length,
  };

  if (!fix) {
    return json({
      ok: true,
      namespace,
      scanned: index.docs.length,
      total_orphans: orphans.length,
      by_kind: byKind,
      auto_fixable: fixCandidates.length,
      orphans,
    });
  }

  // Fix mode: for each data_layer_drift orphan, re-run per-doc reconcile.
  // deleteDocEdges + syncDocEdges is the same recipe reconcile.ts uses.
  const fixed: string[] = [];
  const fixFailed: Array<{ path: string; error: string }> = [];
  for (const path of fixCandidates) {
    try {
      const content = await readVaultFile(ctx, path);
      if (content === null) {
        fixFailed.push({ path, error: "storage read returned null" });
        continue;
      }
      await deleteDocEdges(db, namespace, path);
      await syncDocEdges(db, namespace, path, content);
      fixed.push(path);
    } catch (err) {
      fixFailed.push({ path, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return json({
    ok: true,
    namespace,
    scanned: index.docs.length,
    total_orphans: orphans.length,
    by_kind: byKind,
    fixed_count: fixed.length,
    fixed,
    fix_failed: fixFailed,
    still_needs_human: orphans.filter((o) => o.kind !== "data_layer_drift"),
  });
}
