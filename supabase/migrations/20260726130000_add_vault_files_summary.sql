-- SPRINT-144 (SIG-032 Phase 3, Tier 2 egress fix): add a persisted summary column.
--
-- Companion to SPRINT-143's `title` column. Summary is the blockquote paragraph
-- that follows the H1. Persisting it via a GENERATED expression means the
-- future `/api/index` refactor (SPRINT-146) can fetch (path, title, summary,
-- updated_at) without touching content — completing the ~99% egress reduction
-- story on the read hot path.
--
-- Extraction: first `> ` blockquote line after the H1 (anywhere in the doc,
-- multiline). Strips the leading `> ` marker + trailing whitespace. NULL when
-- the doc has no blockquote.

alter table vault_files
  add column summary text generated always as (
    trim(both from (regexp_match(content, '^>[[:space:]]+(.+?)[[:space:]]*$', 'm'))[1])
  ) stored;

create index if not exists vault_files_ns_updated_at_idx
  on vault_files (namespace, updated_at desc);

comment on column vault_files.summary is
  'First `> blockquote` line extracted from content. GENERATED — auto-updates on write. NULL when doc has no blockquote. See SPRINT-144.';
