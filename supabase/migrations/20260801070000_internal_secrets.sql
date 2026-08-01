-- SPRINT-177 (revised): store shared internal secrets in Postgres instead
-- of Vercel env vars.
--
-- Motivation: `OWNER_METRICS_TOKEN` in the Vercel dashboard is manual
-- ops overhead — no rotation trail, no audit, and every environment
-- promotion needs a manual copy-paste. Storing the hashed secret in the
-- DB puts it in the same auditable surface as everything else EMDEE
-- persists.
--
-- Schema:
--   - `kind` is the logical name of the secret (e.g. 'owner_metrics').
--     Unique — only one active token per kind at a time. Rotation is an
--     UPDATE on the existing row.
--   - `token_hash` is SHA-256 hex of the raw token bytes (64 chars).
--     Never store the raw token. If the DB leaks, the raw token cannot
--     be reconstructed for a 256-bit input.
--   - `label` is a human-readable note (e.g. "whatelz.ai cockpit poll").
--
-- Access model: `for all using (false)`. Service-role bypasses RLS —
-- the route handler uses adminClient() to read; token generation /
-- rotation happens via execute_sql or a future admin CLI. No client
-- ever touches this table directly.

create table public.internal_secrets (
  kind        text primary key,
  token_hash  text not null check (length(token_hash) = 64),
  label       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Keep updated_at fresh on every rotation so the audit trail is legible.
create or replace function public.internal_secrets_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger internal_secrets_touch_updated_at_trigger
  before update on public.internal_secrets
  for each row execute function public.internal_secrets_touch_updated_at();

alter table public.internal_secrets enable row level security;

create policy "no direct client access"
  on public.internal_secrets for all using (false);
