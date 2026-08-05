// SPRINT-182 (Tier 4): weekly belt-and-braces reconcile.
//
// The reactive counterpart at /api/cron/auto-heal-namespaces (SPRINT-165)
// only fires when `namespace_health.orphan_count > 0` — it catches
// data_layer_drift specifically. This route runs `backfillNamespace`
// unconditionally on every namespace once a week, catching non-orphan
// drift the reactive pass misses (wrong edge positions, stale labels,
// one-parent-invariant candidates that don't manifest as orphans).
//
// Schedule: Sun 03:30 UTC (offset from the SPRINT-164/165 daily crons
// at 03:00 / 04:00 so audit logs stay readable). Configured in
// vercel.json.
//
// Auth: same fail-closed pattern as the daily cron — no CRON_SECRET =
// 503; wrong bearer = 401.

import { adminClient } from "@/src/lib/supabase/admin";
import { cloudDatabase } from "@/src/lib/database";
import { backfillNamespace } from "@/src/core/syncDocEdges";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// N namespaces × ~5s each. 20 users → ~2 min; 60s covers ~10 comfortably
// but Vercel Cron will retry on timeout, so we set the wall ceiling
// aggressively and let the retry handle any straggler.
export const maxDuration = 300;

interface ReconcileResult {
  namespace: string;
  ok: boolean;
  docs_scanned?: number;
  edges_written?: number;
  duplicate_parents?: number;
  took_ms?: number;
  error?: string;
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return Response.json({ error: "cron_not_configured" }, { status: 503 });
  }
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = adminClient();
  const db = cloudDatabase();
  const startedAt = new Date().toISOString();

  // Enumerate every namespace we know about via namespace_health — the
  // same source the daily heal-cron uses, so coverage is symmetric.
  const { data: namespaces, error: fetchErr } = await admin
    .from("namespace_health")
    .select("namespace")
    .order("namespace");

  if (fetchErr) {
    return Response.json({ error: "fetch_failed", detail: fetchErr.message }, { status: 500 });
  }

  const results: ReconcileResult[] = [];
  for (const row of namespaces ?? []) {
    const ns = row.namespace as string;
    const t0 = Date.now();
    try {
      const backfill = await backfillNamespace(db, ns);
      results.push({
        namespace: ns,
        ok: true,
        docs_scanned: backfill.docs,
        edges_written: backfill.rows,
        duplicate_parents: backfill.duplicate_parents.length,
        took_ms: Date.now() - t0,
      });
      // Refresh health so any drift we just cleaned is reflected in
      // Monday morning's dashboards.
      await admin.rpc("compute_namespace_health", { ns });
    } catch (err) {
      results.push({
        namespace: ns,
        ok: false,
        took_ms: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return Response.json({
    ok: true,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    namespaces_scanned: results.length,
    namespaces_failed: results.filter((r) => !r.ok).length,
    total_edges_written: results.reduce((s, r) => s + (r.edges_written ?? 0), 0),
    results,
  });
}
