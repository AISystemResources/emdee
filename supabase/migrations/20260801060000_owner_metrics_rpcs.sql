-- SPRINT-177: two SECURITY DEFINER RPCs powering the owner-metrics
-- endpoint at /api/internal/owner-metrics.
--
-- Both return a single jsonb-flavoured row of aggregates. Server-side
-- functions instead of client-side loops so DAU/WAU/MAU can use SQL's
-- native count(distinct …) without pulling raw clerk_id rows to Node.
--
-- Access model: SECURITY DEFINER + revoke public execute + grant to
-- service_role only. Same seal as adminClient()-only tables — no client
-- can hit these directly.

create or replace function public.owner_metrics_business()
returns table (
  dau int,
  wau int,
  mau int,
  signups_7d int,
  active_workspaces int
)
language sql
security definer
set search_path = public
as $$
  select
    (select count(distinct clerk_id) from mcp_activity where created_at > now() - interval '24 hours')::int as dau,
    (select count(distinct clerk_id) from mcp_activity where created_at > now() - interval '7 days')::int as wau,
    (select count(distinct clerk_id) from mcp_activity where created_at > now() - interval '30 days')::int as mau,
    (select count(*) from profiles where created_at > now() - interval '7 days')::int as signups_7d,
    (select count(*) from profiles)::int as active_workspaces;
$$;

create or replace function public.owner_metrics_usage()
returns table (
  docs_total int,
  docs_added_7d int,
  sections_added_7d int,
  sections_updated_7d int,
  mcp_calls_7d int
)
language sql
security definer
set search_path = public
as $$
  select
    (select count(*) from vault_files)::int as docs_total,
    (select count(*) from mcp_activity
       where created_at > now() - interval '7 days'
         and tool_name in ('create_child','split_doc','materialize_subgroup','upload_image'))::int as docs_added_7d,
    (select count(*) from mcp_activity
       where created_at > now() - interval '7 days'
         and tool_name in ('append_section','append_doc'))::int as sections_added_7d,
    (select count(*) from mcp_activity
       where created_at > now() - interval '7 days'
         and tool_name = 'patch_section')::int as sections_updated_7d,
    (select count(*) from mcp_activity
       where created_at > now() - interval '7 days')::int as mcp_calls_7d;
$$;

-- Lock down to service_role. The route handler uses adminClient() which
-- authenticates as service_role. Anon/authenticated can't call these.
revoke all on function public.owner_metrics_business() from public;
revoke all on function public.owner_metrics_usage() from public;
grant execute on function public.owner_metrics_business() to service_role;
grant execute on function public.owner_metrics_usage() to service_role;
