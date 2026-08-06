import { adminClient } from "../../supabase/admin";
import type { ToolContext } from "./types";

// SPRINT-173: cross-project ticket queue — list verb.
// Cloud-only. Scoped to the caller's namespace; supports pillar + status
// filters plus limit/offset. Ordered newest-first (created_at desc,
// matching the composite indexes).

const PILLARS = ["cmo", "cpo", "coo", "ceo"] as const;
const STATUSES = ["open", "in_progress", "done", "blocked"] as const;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export async function listTickets(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  if (ctx.mode !== "cloud") {
    return json({ error: "cloud_mode_required" });
  }

  // Validate all inputs BEFORE touching adminClient(). Instantiating the
  // Supabase client requires env vars that test envs don't always set;
  // deferring the client build until after validation keeps error
  // responses legible in both prod and stub-cloud unit tests.
  let pillarFilter: string | null = null;
  if (args.pillar !== undefined && args.pillar !== null) {
    const pillar = typeof args.pillar === "string" ? args.pillar.toLowerCase() : "";
    if (!(PILLARS as readonly string[]).includes(pillar)) {
      return json({ error: "invalid_pillar", allowed: PILLARS });
    }
    pillarFilter = pillar;
  }

  let statusFilter: string | null = null;
  if (args.status !== undefined && args.status !== null) {
    const status = typeof args.status === "string" ? args.status.toLowerCase() : "";
    if (!(STATUSES as readonly string[]).includes(status)) {
      return json({ error: "invalid_status", allowed: STATUSES });
    }
    statusFilter = status;
  }

  // SPRINT-185: optional agent-address filter. The primary shape for an
  // agent's own inbox: list_tickets(assigned_agent_id = me, status = "open").
  let assignedAgentFilter: string | null = null;
  if (args.assigned_agent_id !== undefined && args.assigned_agent_id !== null) {
    if (typeof args.assigned_agent_id !== "string" || args.assigned_agent_id.trim().length === 0) {
      return json({ error: "invalid_assigned_agent_id" });
    }
    assignedAgentFilter = args.assigned_agent_id.trim();
  }

  const rawLimit = Number(args.limit ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(rawLimit))) : DEFAULT_LIMIT;
  const rawOffset = Number(args.offset ?? 0);
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;

  let query = adminClient()
    .from("tickets")
    .select("id, namespace, pillar, type, status, priority, payload, assigned_agent_id, sender_agent_id, created_at, updated_at, resolved_at, first_resolved_at")
    .eq("namespace", ctx.userId);
  if (pillarFilter) query = query.eq("pillar", pillarFilter);
  if (statusFilter) query = query.eq("status", statusFilter);
  if (assignedAgentFilter) query = query.eq("assigned_agent_id", assignedAgentFilter);
  query = query.order("created_at", { ascending: false }).range(offset, offset + limit - 1);

  const { data, error } = await query;
  if (error) return json({ error: "select_failed", detail: error.message });

  return json({ ok: true, count: data?.length ?? 0, limit, offset, tickets: data ?? [] });
}
