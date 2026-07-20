-- SPRINT-108 (Fix 2): atomic doc_edges sync via RPC.
--
-- The previous syncDocEdges implementation ran DELETEs then UPSERTs as
-- separate PostgREST round-trips. If the UPSERT failed (e.g., unique
-- constraint violation from a race with another doc's sync), the DELETEs
-- had already committed — leaving the doc with FEWER edges than intended.
-- Users observed this as sidebar orphans: a doc's parent edge silently
-- disappeared even though the markdown was correct.
--
-- Fix: wrap DELETE + INSERT in a single transaction via this RPC. Either
-- both apply or neither. On constraint violation, the transaction rolls
-- back cleanly and the caller surfaces the error — no more silent drift.
--
-- The function does exactly what the TypeScript diff-based sync was doing,
-- but atomically:
--   1. Delete every row where namespace matches AND (from_path OR to_path)
--      equals p_doc_path — the "current rows touching this doc" set.
--   2. Insert every row in p_desired — the recomputed desired set for
--      this doc.
--
-- Naive over-delete-then-reinsert is simpler than the diff and just as
-- fast at typical vault sizes (< 20 edges per doc). Atomicity guarantee
-- is what matters.
--
-- Called from src/core/syncDocEdges.ts via admin.rpc(...).

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

  -- Step 2: insert the fresh desired set (may be empty for delete calls).
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

-- Service-role only — nothing else should be mutating doc_edges directly.
revoke all on function public.sync_doc_edges_atomic(text, text, jsonb) from public;
revoke execute on function public.sync_doc_edges_atomic(text, text, jsonb) from anon;
revoke execute on function public.sync_doc_edges_atomic(text, text, jsonb) from authenticated;
grant execute on function public.sync_doc_edges_atomic(text, text, jsonb) to service_role;

comment on function public.sync_doc_edges_atomic(text, text, jsonb) is
  'SPRINT-108 Fix 2: atomic delete+insert for doc_edges sync. Called from src/core/syncDocEdges.ts to replace the non-atomic PostgREST delete+upsert sequence.';
