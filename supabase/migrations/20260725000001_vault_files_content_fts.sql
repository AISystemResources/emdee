-- SPRINT-122b: Postgres full-text search on vault_files.content.
--
-- Zero external dependencies (no LLM, no embeddings service). Pure
-- Postgres built-in FTS with english dictionary + GIN index. Captures
-- surface/keyword overlap between docs; misses true semantic bridges
-- (transformer ≈ attention) but ships with no ongoing cost, no data
-- egress, no proprietary lock-in.
--
-- The generated tsvector column keeps the index in sync automatically
-- on every content write via vault_files.upsert. GIN is the right
-- choice for full-text: build-once, cheap query, supports ts_rank.

alter table public.vault_files
  add column if not exists content_tsv tsvector
  generated always as (to_tsvector('english', coalesce(content, ''))) stored;

create index if not exists vault_files_content_tsv_idx
  on public.vault_files using gin (content_tsv);
