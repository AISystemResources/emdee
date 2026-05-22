-- SPRINT-018 Phase 1: materialized doc-edges table.
-- Edges are derived from each doc's `## Parent of` (hierarchy) and
-- `## Associated with` (assoc) bullets. Hierarchy: from = parent, to = child.
-- Assoc: stored as TWO rows (A->B and B->A) so either-direction lookup is a
-- single index scan. Position preserves bullet order from the source section.

create table public.doc_edges (
  namespace text not null,
  from_path text not null,
  to_path   text not null,
  kind      text not null check (kind in ('hierarchy', 'assoc')),
  label     text,
  position  integer not null default 0,
  primary key (namespace, from_path, to_path, kind)
);

create index doc_edges_from_idx on public.doc_edges (namespace, from_path);
create index doc_edges_to_idx   on public.doc_edges (namespace, to_path);

alter table public.doc_edges enable row level security;

-- Edges follow the same access model as vault_files: service-role-only
-- access via the admin client. No client-direct policies needed; all
-- reads/writes go through application-layer handlers that gate on the
-- caller's vault namespace.
