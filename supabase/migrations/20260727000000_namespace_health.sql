-- SPRINT-164: namespace_health telemetry + nightly cron.
--
-- Enables ops-scale visibility into every user's vault health without
-- Edmund having to run per-user diagnostics by hand. Feeds:
--   - SPRINT-165 auto-heal daemon (auto-runs reconcile on drift-flavored
--     orphans)
--   - SPRINT-166 /admin/health dashboard (triage surface for orphans and
--     stale shares that auto-heal can't handle)
--
-- Runs nightly at 03:00 UTC (low-traffic window). Scans namespaces with
-- vault_files activity in the last 30 days. Table is a snapshot cache
-- (one row per namespace, overwritten each scan) — full history goes to
-- autofix_log jsonb so we can eyeball trends without a separate audit
-- table.

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- One row per namespace. Overwritten each scan. autofix_log is a
-- rolling jsonb array of {ts, path, action} entries the SPRINT-165 daemon
-- appends to.
CREATE TABLE IF NOT EXISTS public.namespace_health (
  namespace text PRIMARY KEY,
  total_files int NOT NULL DEFAULT 0,
  orphan_count int NOT NULL DEFAULT 0,
  stale_share_count int NOT NULL DEFAULT 0,
  unreachable_share_count int NOT NULL DEFAULT 0,
  autofix_log jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_scan_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS namespace_health_severity_idx
  ON public.namespace_health ((orphan_count + stale_share_count + unreachable_share_count) DESC);

-- Compute health metrics for a single namespace and upsert into
-- namespace_health. Pure SQL — no markdown parsing, so this captures
-- data_layer_drift + structural_orphan (both = "no incoming hierarchy
-- edge in doc_edges") but NOT markdown_drift (which needs a full parse).
-- Good enough for triage; SPRINT-165 auto-heal fixes the data_layer
-- flavour via per-doc reconcile.
CREATE OR REPLACE FUNCTION public.compute_namespace_health(ns text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total int;
  v_orphans int;
  v_stale_shares int;
  v_unreachable_shares int;
BEGIN
  SELECT count(*) INTO v_total
  FROM vault_files WHERE namespace = ns;

  -- Orphans: docs with no incoming hierarchy edge, excluding the 5
  -- virtual system nodes (they're never in doc_edges by design) and the
  -- owner root (single top-level uppercase .md file whose declared
  -- parent is the virtual EMDEE node — always "orphan" at the SQL layer,
  -- by design).
  SELECT count(*) INTO v_orphans
  FROM vault_files vf
  WHERE vf.namespace = ns
    AND vf.file_path NOT IN ('EMDEE.md', 'VAULT.md', 'SHARED.md', 'GRAVEYARD.md', 'IMAGES.md')
    -- Exclude owner root: no slash in path.
    AND vf.file_path LIKE '%/%'
    AND NOT EXISTS (
      SELECT 1 FROM doc_edges de
      WHERE de.namespace = ns
        AND de.to_path = vf.file_path
        AND de.kind = 'hierarchy'
    );

  -- Stale shares: share row's target doc exists but has no incoming
  -- hierarchy edge in owner's namespace (grantee sees it as an orphan).
  SELECT count(*) INTO v_stale_shares
  FROM doc_shares ds
  WHERE ds.owner_id = ns
    AND EXISTS (
      SELECT 1 FROM vault_files vf
      WHERE vf.namespace = ns AND vf.file_path = ds.path_prefix
    )
    AND NOT EXISTS (
      SELECT 1 FROM doc_edges de
      WHERE de.namespace = ns
        AND de.to_path = ds.path_prefix
        AND de.kind = 'hierarchy'
    );

  -- Unreachable shares: share row points at a doc that no longer exists
  -- (deleted, renamed, or path drift). These should be revoked.
  SELECT count(*) INTO v_unreachable_shares
  FROM doc_shares ds
  WHERE ds.owner_id = ns
    AND NOT EXISTS (
      SELECT 1 FROM vault_files vf
      WHERE vf.namespace = ns AND vf.file_path = ds.path_prefix
    );

  INSERT INTO namespace_health (
    namespace, total_files, orphan_count, stale_share_count,
    unreachable_share_count, last_scan_at, updated_at
  )
  VALUES (
    ns, v_total, v_orphans, v_stale_shares,
    v_unreachable_shares, now(), now()
  )
  ON CONFLICT (namespace) DO UPDATE SET
    total_files = EXCLUDED.total_files,
    orphan_count = EXCLUDED.orphan_count,
    stale_share_count = EXCLUDED.stale_share_count,
    unreachable_share_count = EXCLUDED.unreachable_share_count,
    last_scan_at = EXCLUDED.last_scan_at,
    updated_at = EXCLUDED.updated_at;
END;
$$;

-- Scan every namespace with vault_files activity in the last 30 days.
-- Returns count of namespaces scanned. Cron target.
CREATE OR REPLACE FUNCTION public.refresh_namespace_health()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ns_rec record;
  n int := 0;
BEGIN
  FOR ns_rec IN
    SELECT DISTINCT namespace
    FROM vault_files
    WHERE updated_at > now() - interval '30 days'
  LOOP
    PERFORM compute_namespace_health(ns_rec.namespace);
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$;

-- Schedule nightly at 03:00 UTC. Unschedule any prior entry first to
-- keep the migration idempotent (re-applying wouldn't create duplicate
-- cron jobs).
DO $$
DECLARE
  existing_jobid bigint;
BEGIN
  SELECT jobid INTO existing_jobid FROM cron.job WHERE jobname = 'namespace-health-nightly';
  IF existing_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(existing_jobid);
  END IF;
END $$;

SELECT cron.schedule(
  'namespace-health-nightly',
  '0 3 * * *',
  $$SELECT refresh_namespace_health()$$
);

-- Backfill: run once at migration apply time so admin dashboards have
-- data immediately (rather than waiting until 03:00 UTC).
SELECT refresh_namespace_health();
