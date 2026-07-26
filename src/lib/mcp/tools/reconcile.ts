import { readVaultFile } from "./vault";
import { syncDocEdges, deleteDocEdges, backfillNamespace } from "../../../core/syncDocEdges";
import { ctxNamespace, ensureLocalIndex } from "./context";
import type { ToolContext } from "./types";

// SPRINT-108 Fix 3: user-facing repair verb for doc_edges drift.
//
// Motivation: even with Fix 1 (move_doc completion audit) and Fix 2
// (syncDocEdges atomic RPC) preventing NEW drift, historical vaults may
// still contain rows where doc_edges disagrees with markdown truth. The
// only recourse today is the namespace-wide backfill script in
// scripts/archive/backfill-doc-edges.ts — which only the operator can
// run. This gives every authenticated user a first-class CLI tool to
// self-repair their own namespace's drift.
//
// Two modes:
//   - Per-doc:  `emdee reconcile --path <X> --remote`
//     Deletes all doc_edges rows touching X, re-runs syncDocEdges from
//     the current Storage content. Fixes rows for X and its immediate
//     neighbours (any other doc's Parent-of / Child-of / Associated-with
//     that references X gets its X-side row recomputed).
//   - Full namespace: `emdee reconcile --all --remote`
//     Delegates to backfillNamespace — wipes and rebuilds every doc_edges
//     row for the caller's namespace from markdown truth. Heaviest but
//     most thorough. Use when per-doc reconciles don't converge or the
//     drift is broad.
//
// Cloud-only; local mode has no doc_edges (indexer rebuilds on every read).

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export async function reconcile(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const all = args.all === true;
  const targetPath = typeof args.path === "string" && args.path.length > 0 ? args.path : null;

  if (!all && !targetPath) {
    return json({
      error: "path_or_all_required",
      hint: "pass --path <X> for per-doc reconcile, or --all for namespace-wide",
    });
  }
  if (all && targetPath) {
    return json({
      error: "path_and_all_conflict",
      hint: "use either --path or --all, not both",
    });
  }

  await ensureLocalIndex(ctx);
  const db = ctx.db;
  const namespace = ctxNamespace(ctx);

  if (all) {
    const result = await backfillNamespace(db, namespace);
    return json({
      ok: true,
      mode: "namespace",
      namespace,
      docs_scanned: result.docs,
      edges_written: result.rows,
      duplicate_parents: result.duplicate_parents,
    });
  }

  const content = await readVaultFile(ctx, targetPath!);
  if (content === null) {
    await deleteDocEdges(db, namespace, targetPath!);
    return json({
      ok: true,
      mode: "per-doc",
      path: targetPath,
      note: "doc doesn't exist on Storage — cleared all doc_edges rows referencing it",
      edges_deleted: true,
    });
  }

  await deleteDocEdges(db, namespace, targetPath!);
  await syncDocEdges(db, namespace, targetPath!, content);

  return json({
    ok: true,
    mode: "per-doc",
    path: targetPath,
    note: "cleared and rebuilt doc_edges rows touching this doc",
  });
}
