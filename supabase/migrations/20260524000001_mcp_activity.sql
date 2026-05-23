-- SPRINT-021 Phase 1: ephemeral MCP tool-call log.
-- Rows are auto-purged after 5 minutes (see TTL note at bottom). The table
-- exists solely to fan tool-call events out to clients; it is NOT an audit
-- log (vault_files history serves that role).
--
-- Access model: service-role only. The MCP tool-call wrappers insert rows
-- via adminClient(); an SSE route (/api/mcp-activity) authenticates the
-- caller via Clerk server-side and polls this table with the same admin
-- client, forwarding rows that match the caller's namespace.
--
-- Why not Supabase Realtime + an RLS select policy: the project has no
-- Clerk→Supabase JWT bridging wired (browser supabase client uses anon
-- key with no auth token), so `auth.jwt() ->> 'sub'` is null in client
-- subscriptions and a namespace-scoped RLS policy would filter every row
-- out. Wiring the bridge (Clerk JWT template + supabase accessToken
-- callback) would let a future sprint flip back to native realtime — the
-- table layout below is already compatible.

create table public.mcp_activity (
  id          uuid primary key default gen_random_uuid(),
  namespace   text not null,
  clerk_id    text not null,
  tool_name   text not null,
  doc_path    text,
  action_kind text not null check (action_kind in
    ('read','write','delete','rename','search','lint','other')),
  args_summary jsonb,
  created_at  timestamptz not null default now()
);

create index mcp_activity_ns_created_idx
  on public.mcp_activity (namespace, created_at desc);

alter table public.mcp_activity enable row level security;

-- Service-role only. Mirrors sync_manifest / pat_tokens: every read and
-- write goes through a server-side route that uses the service-role key.
create policy "no direct client access"
  on public.mcp_activity for all using (false);

-- TTL — pg_cron is NOT installed in this project (verified via
-- list_extensions on 2026-05-24). To enable scheduled cleanup:
--   1. Enable pg_cron via the Supabase dashboard → Database → Extensions.
--   2. Uncomment the block below and re-run as a migration.
-- Until then, the SSE poller may opportunistically prune old rows, or a
-- future maintenance migration can issue a one-shot delete. Worst case
-- the table grows linearly with tool calls — fine for the sprint horizon.
--
-- select cron.schedule(
--   'mcp_activity_ttl',
--   '* * * * *',
--   $$delete from public.mcp_activity where created_at < now() - interval '5 minutes'$$
-- );
