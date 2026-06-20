-- SPRINT-046: expose supabase_migrations.schema_migrations as a SECURITY
-- DEFINER RPC so scripts/check-migration-drift.mjs can read it via PostgREST.
--
-- supabase_migrations is a system schema not exposed via the REST API by
-- default. A SECURITY DEFINER function owned by postgres lets the
-- service-role caller read the row set without granting blanket access to
-- the schema. anon + authenticated are revoked so this isn't a recon
-- surface for unauthenticated visitors (see DOUBLELEAD advisor snapshot:
-- list_applied_migrations should never be exposed to anon).

create or replace function public.list_applied_migrations()
returns table (version text, name text)
language sql
security definer
set search_path = ''
as $$
  select version::text, name::text
  from supabase_migrations.schema_migrations
  order by version asc;
$$;

revoke all on function public.list_applied_migrations() from public;
revoke execute on function public.list_applied_migrations() from anon;
revoke execute on function public.list_applied_migrations() from authenticated;
grant execute on function public.list_applied_migrations() to service_role;

comment on function public.list_applied_migrations() is
  'SPRINT-046: read-only view of applied Supabase migrations for the CI drift check. Service-role only.';
