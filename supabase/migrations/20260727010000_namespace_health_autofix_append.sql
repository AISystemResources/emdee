-- SPRINT-165: helper to append entries to namespace_health.autofix_log
-- from the Vercel Cron auto-heal daemon. Trims to the most recent 50
-- entries so the jsonb column doesn't grow unbounded across nightly
-- runs (~18k entries/year per namespace otherwise).

CREATE OR REPLACE FUNCTION public.append_autofix_log(ns text, entry jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE namespace_health
  SET
    autofix_log = (
      -- Trim to last 50 entries after appending.
      SELECT jsonb_agg(e)
      FROM (
        SELECT e FROM jsonb_array_elements(autofix_log || jsonb_build_array(entry)) AS e
        ORDER BY (e->>'ts') DESC
        LIMIT 50
      ) trimmed
    ),
    updated_at = now()
  WHERE namespace = ns;
END;
$$;
