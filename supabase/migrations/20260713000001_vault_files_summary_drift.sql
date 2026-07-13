-- SPRINT-081: per-doc summary drift tracking.
--
-- Adds two nullable columns to vault_files so the summariser workflow can
-- surface docs whose body has changed since their summary was last touched.
--
-- Semantics (populated by SupabaseStorage.write):
--   summary_hash                    — hashBody(deriveSummary(content)); "" if no summary.
--   content_hash_at_summary_write   — hashBody(content) snapshot taken the last time summary_hash changed.
--
-- Drift = hashBody(content_now) != content_hash_at_summary_write.
-- NULL in either column means "never baselined post-migration" — the summariser
-- treats these as candidates, which is intentional: on first pass every doc
-- gets a proposed summary review. Subsequent writes populate both columns and
-- drift tracking kicks in naturally.
--
-- No backfill: adding backfill would claim "current summaries are up-to-date"
-- which contradicts the sprint goal (review the first batch before automating).

ALTER TABLE public.vault_files
  ADD COLUMN IF NOT EXISTS summary_hash TEXT,
  ADD COLUMN IF NOT EXISTS content_hash_at_summary_write TEXT;

-- Partial index accelerates the drift query — only rows past first-post-migration
-- write carry the column, and only those matter to the drift filter.
CREATE INDEX IF NOT EXISTS vault_files_ns_summary_drift_idx
  ON public.vault_files (namespace, content_hash_at_summary_write)
  WHERE content_hash_at_summary_write IS NOT NULL;
