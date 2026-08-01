-- SPRINT-174: enable RLS on public.namespace_health.
--
-- Closes the Priority-1 security advisor Supabase MCP flags on every
-- get_advisors call. The table was created in SPRINT-164 (migration
-- 20260727000000_namespace_health.sql) but shipped without RLS — this
-- migration seals it.
--
-- No caller impact: the only reader is app/api/cron/auto-heal-namespaces
-- (SPRINT-165), which uses the service-role adminClient(); service-role
-- bypasses RLS by design. Every namespace_health mutation happens inside
-- the SECURITY DEFINER RPCs `compute_namespace_health` and
-- `refresh_namespace_health` from the same 20260727 migration —
-- SECURITY DEFINER runs as the function owner (postgres), which also
-- bypasses RLS.
--
-- Policy shape mirrors mcp_activity / sync_manifest / tickets: hard-off
-- for anon + authenticated roles, service-role only.

alter table public.namespace_health enable row level security;

create policy "no direct client access"
  on public.namespace_health for all using (false);
