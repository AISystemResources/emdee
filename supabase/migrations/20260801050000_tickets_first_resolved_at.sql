-- SPRINT-176: add tickets.first_resolved_at column + trigger.
--
-- SPRINT-173 shipped tickets with a `resolved_at` that clears on every
-- transition away from 'done' — a reopen→reclose loses the original
-- resolution timestamp. Deliberate simplification at the time; flagged
-- in the SPRINT-173 close-out as follow-up if analytics ever need first-
-- close attribution.
--
-- This migration adds `first_resolved_at` as a nullable column stamped
-- exactly once — on the FIRST transition to 'done', never touched again.
-- Both signals stay legible:
--   - `resolved_at`       = "when did this ticket most recently close?"
--   - `first_resolved_at` = "when did this ticket first close?"
--
-- Handled server-side via trigger so update_ticket.ts stays as-is (one
-- write, no round-trip to check whether it's the first close). Trigger
-- fires on any status update AND on INSERT (in case a ticket is ever
-- created directly in the 'done' state).

alter table public.tickets
  add column first_resolved_at timestamptz;

-- Backfill: for any ticket already at status='done' when this migration
-- lands, seed first_resolved_at from resolved_at. Losing precision is
-- acceptable since we didn't track this before; anything resolved AFTER
-- this migration gets exact provenance from the trigger.
update public.tickets
  set first_resolved_at = resolved_at
  where status = 'done'
    and resolved_at is not null
    and first_resolved_at is null;

-- Trigger: stamp first_resolved_at on the FIRST done transition only.
-- Never overwrites a non-null first_resolved_at, so reopen→reclose keeps
-- the original stamp intact.
create or replace function public.tickets_stamp_first_resolved_at()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'done'
     and new.first_resolved_at is null then
    new.first_resolved_at := coalesce(new.resolved_at, now());
  end if;
  return new;
end;
$$;

create trigger tickets_first_resolved_at_stamp
  before insert or update of status on public.tickets
  for each row execute function public.tickets_stamp_first_resolved_at();
