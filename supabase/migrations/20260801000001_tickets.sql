-- SPRINT-173: cross-project ticket queue.
--
-- One shared table for operational tickets from the four AI agents
-- (CMO / CPO / COO / CEO), each living in its own GitHub repo. All four
-- OAuth into EMDEE as the vault owner, so `namespace` (the owner's
-- clerk_id) scopes every read and write — mirrors the mcp_activity /
-- vault_files convention.
--
-- Access model: service-role only. Mirrors mcp_activity / sync_manifest.
-- External agents hit `POST /api/mcp` with an OAuth bearer; the route
-- resolves the caller's clerk_id and issues the query through
-- adminClient(), scoped by namespace. No client (anon key) ever reads
-- this table directly — RLS is `for all using (false)`.
--
-- Why not RLS-scoped anon read: EMDEE has no Clerk→Supabase JWT bridge
-- (documented in 20260524000001_mcp_activity.sql lines 12–17), so
-- `auth.jwt() ->> 'sub'` is null in client subscriptions. A per-user RLS
-- policy would filter every row out. The server-mediated path preserves
-- per-user scoping today without that infrastructure lift.

create table public.tickets (
  id           uuid primary key default gen_random_uuid(),
  namespace    text not null,
  pillar       text not null check (pillar in ('cmo','cpo','coo','ceo')),
  type         text not null,
  status       text not null default 'open'
                 check (status in ('open','in_progress','done','blocked')),
  payload      jsonb not null default '{}'::jsonb,
  priority     text not null default 'medium'
                 check (priority in ('low','medium','high')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  resolved_at  timestamptz
);

-- Primary query pattern: list caller's tickets filtered by status +
-- optionally pillar, newest first. Two indexes cover the two filter
-- shapes without a full table scan.
create index tickets_ns_status_created_idx
  on public.tickets (namespace, status, created_at desc);

create index tickets_ns_pillar_created_idx
  on public.tickets (namespace, pillar, created_at desc);

alter table public.tickets enable row level security;

create policy "no direct client access"
  on public.tickets for all using (false);
