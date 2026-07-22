-- SPRINT-116: syncDocEdges self-heal on constraint violation.
--
-- Bug: the SPRINT-108 atomic RPC deletes rows touching the doc being
-- written, then inserts the desired set. It does NOT preempt hierarchy
-- edges that OTHER docs establish with the same to_path. Result:
-- inserting `parent_A → child` fails with `doc_edges_one_parent`
-- violation when another edge `parent_B → child` already exists (from
-- a stale write, a trashed hub, a mid-migration inconsistency).
--
-- This surfaced during EMDEE_OS P/M/O migration 2026-07-22: 51/79 (65%)
-- of bulk wiki-link rewrites failed with this exact constraint. Real
-- users doing large-scale vault reorganizations would hit the same
-- ceiling.
--
-- Fix: the RPC's DELETE clause now ALSO removes any pre-existing
-- hierarchy edge whose `to_path` matches one we're about to insert.
-- The write's stated parent wins — matching the "markdown is truth"
-- invariant. Any other hub that also claims this child in its markdown
-- will fall out of sync (asymmetric edge), which is a lint concern the
-- user can address, not a sync-time hard error.
--
-- The naive over-delete-then-reinsert stays atomic within one
-- transaction, so partial state cannot leak.

create or replace function public.sync_doc_edges_atomic(
  p_namespace text,
  p_doc_path text,
  p_desired jsonb
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Step 1: remove every existing edge touching this doc.
  delete from public.doc_edges
  where namespace = p_namespace
    and (from_path = p_doc_path or to_path = p_doc_path);

  -- Step 2 (SPRINT-116 fix): remove any pre-existing hierarchy edge
  -- whose to_path we're about to claim. Prevents doc_edges_one_parent
  -- unique-constraint violations when the desired parent differs from
  -- whatever stale row already exists.
  delete from public.doc_edges
  where namespace = p_namespace
    and kind = 'hierarchy'
    and to_path in (
      select (r->>'to_path')::text
      from jsonb_array_elements(p_desired) r
      where (r->>'kind')::text = 'hierarchy'
    );

  -- Step 3: insert the fresh desired set (may be empty for delete calls).
  if jsonb_array_length(p_desired) > 0 then
    insert into public.doc_edges (namespace, from_path, to_path, kind, label, position)
    select
      p_namespace,
      (r->>'from_path')::text,
      (r->>'to_path')::text,
      (r->>'kind')::text,
      (r->>'label')::text,
      coalesce((r->>'position')::int, 0)
    from jsonb_array_elements(p_desired) r;
  end if;
end;
$$;

comment on function public.sync_doc_edges_atomic(text, text, jsonb) is
  'SPRINT-116: atomic delete+insert with self-heal. Preempts one_parent constraint violations by removing stale hierarchy edges for any to_path in the incoming desired set. Called from src/core/syncDocEdges.ts.';
