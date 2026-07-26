// SPRINT-165: auto-heal daemon.
//
// Nightly Vercel Cron reads namespace_health for any namespace with
// orphan_count > 0 (populated by SPRINT-164's pg_cron nightly scan)
// and runs backfillNamespace to rebuild that namespace's doc_edges
// from markdown truth. Fixes the data_layer_drift class silently
// without Edmund having to click anything.
//
// Auth: Vercel Cron sends `Authorization: Bearer $CRON_SECRET` on every
// scheduled invocation. Any request without that header returns 401.
// Manual invocations can hit this too — same auth requirement.
//
// Runs at 04:00 UTC (one hour after SPRINT-164's health scan at 03:00,
// so the metrics we read are fresh). Configured in vercel.json.

import { adminClient } from "@/src/lib/supabase/admin";
import { cloudDatabase } from "@/src/lib/database";
import { backfillNamespace } from "@/src/core/syncDocEdges";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Backfill iterates all docs in a namespace; large vaults (1000+ docs)
// need more than the default 10s.
export const maxDuration = 60;

interface HealResult {
  namespace: string;
  ok: boolean;
  previous_orphan_count?: number;
  docs_scanned?: number;
  edges_written?: number;
  error?: string;
}

export async function GET(request: Request) {
  // Vercel Cron auth. If CRON_SECRET is unset the endpoint refuses ALL
  // requests — fail-closed is the safe default for an admin daemon.
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

  const { data: needsHealing, error: fetchErr } = await admin
    .from("namespace_health")
    .select("namespace, orphan_count")
    .gt("orphan_count", 0)
    .order("orphan_count", { ascending: false });

  if (fetchErr) {
    return Response.json({ error: "fetch_failed", detail: fetchErr.message }, { status: 500 });
  }

  const results: HealResult[] = [];

  for (const row of needsHealing ?? []) {
    const previous = row.orphan_count as number;
    try {
      const backfill = await backfillNamespace(db, row.namespace as string);
      const entry = {
        ts: new Date().toISOString(),
        action: "backfill_namespace",
        docs_scanned: backfill.docs,
        edges_written: backfill.rows,
        previous_orphan_count: previous,
      };
      // Append to audit log, then recompute metrics so the next scan
      // reflects the auto-heal impact.
      await admin.rpc("append_autofix_log", { ns: row.namespace, entry });
      await admin.rpc("compute_namespace_health", { ns: row.namespace });
      results.push({
        namespace: row.namespace as string,
        ok: true,
        previous_orphan_count: previous,
        docs_scanned: backfill.docs,
        edges_written: backfill.rows,
      });
    } catch (err) {
      results.push({
        namespace: row.namespace as string,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return Response.json({
    ok: true,
    scanned_at: new Date().toISOString(),
    namespaces_healed: results.filter((r) => r.ok).length,
    namespaces_failed: results.filter((r) => !r.ok).length,
    results,
  });
}
