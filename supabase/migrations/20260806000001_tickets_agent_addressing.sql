-- SPRINT-185: agent-addressed ticketing.
--
-- Extends the SPRINT-173 tickets table so tickets can be routed to a
-- specific agent (e.g. "whatelz:cmo") rather than only to a coarse
-- pillar. Pillar remains for backwards compatibility — it stays a
-- required column with the existing CHECK constraint, and every
-- existing caller still works untouched.
--
-- The new fields are optional strings — no enforced schema, no check
-- constraints. Convention is "project:role" (whatelz:cmo, emdee:cpo)
-- but the code treats it as an opaque slug. Convention lives in the
-- vault/AGENTS/ role templates and in the agent-loop skill, not here.
--
-- Adds an inbox index tuned for the primary agent poll shape:
-- "give me my open tickets, newest first".

alter table public.tickets
  add column if not exists assigned_agent_id text,
  add column if not exists sender_agent_id text;

create index if not exists tickets_agent_inbox_idx
  on public.tickets (namespace, assigned_agent_id, status, created_at desc);
