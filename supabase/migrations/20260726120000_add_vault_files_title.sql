-- SPRINT-143 (SIG-032 Phase 3, Tier 1 egress fix):
--
-- Add a persisted `title` column to vault_files. Previously, syncDocEdges
-- fetched the FULL content column for every doc in the namespace on every
-- write, just to re-derive titles for wiki-link resolution. On a 1224-doc
-- vault (~4 MB content), a bulk-cleanup session of 555 writes cost ~2 GB
-- of egress in one day (25 Jul 2026).
--
-- With `title` persisted, syncDocEdges reads (file_path, title) — ~50 KB
-- for the same vault — a ~99% reduction on the sync hot path.
--
-- Postgres GENERATED column keeps title in sync with content automatically:
-- any INSERT/UPDATE to content re-derives title. No app-code coordination
-- needed. Falls back to NULL when the doc has no H1 line; syncDocEdges
-- treats that as "use filename slug", matching the existing behaviour of
-- deriveTitle() in TS.

alter table vault_files
  add column title text generated always as (
    trim(both from (regexp_match(content, '^#[[:space:]]+(.+?)[[:space:]]*$', 'm'))[1])
  ) stored;

-- Speed up any query that filters on title (few today; future proofing).
create index if not exists vault_files_ns_title_idx
  on vault_files (namespace, title)
  where title is not null;

comment on column vault_files.title is
  'H1 title extracted from content. GENERATED — auto-updates on write. NULL when doc has no ^# heading. See SPRINT-143.';
