import { adminClient } from "../../supabase/admin";
import type { ToolContext } from "./types";
import { hasScope } from "../scopes";

// SPRINT-173: cross-project ticket queue — update verb.
// Cloud-only. Any of status / priority / payload may be updated in a
// single call; at least one must be present. updated_at is always
// refreshed; resolved_at flips to now() the first time status becomes
// 'done' (and back to null if the ticket is reopened).

const STATUSES = ["open", "in_progress", "done", "blocked"] as const;
const PRIORITIES = ["low", "medium", "high"] as const;

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export async function updateTicket(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  if (ctx.mode !== "cloud") {
    return json({ error: "cloud_mode_required" });
  }

  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (id.length === 0) return json({ error: "id_required" });

  const patch: Record<string, unknown> = {};

  if (args.status !== undefined && args.status !== null) {
    const status = typeof args.status === "string" ? args.status.toLowerCase() : "";
    if (!(STATUSES as readonly string[]).includes(status)) {
      return json({ error: "invalid_status", allowed: STATUSES });
    }
    patch.status = status;
    // resolved_at reflects the MOST RECENT close: set on 'done', cleared
    // on any other transition. first_resolved_at (SPRINT-176) is stamped
    // exactly once by the trigger `tickets_first_resolved_at_stamp` and
    // is never touched from tool code — reopen→reclose preserves it.
    patch.resolved_at = status === "done" ? new Date().toISOString() : null;
  }

  if (args.priority !== undefined && args.priority !== null) {
    const priority = typeof args.priority === "string" ? args.priority.toLowerCase() : "";
    if (!(PRIORITIES as readonly string[]).includes(priority)) {
      return json({ error: "invalid_priority", allowed: PRIORITIES });
    }
    patch.priority = priority;
  }

  if (args.payload !== undefined && args.payload !== null) {
    const rec = asRecord(args.payload);
    if (!rec) return json({ error: "invalid_payload", hint: "payload must be a JSON object" });
    patch.payload = rec;
  }

  if (Object.keys(patch).length === 0) {
    return json({ error: "no_updatable_fields", hint: "pass at least one of status / priority / payload" });
  }

  // SPRINT-178: pillar-specific scope check. Fetch the ticket first
  // (namespace-scoped) so we know its pillar, then verify the token
  // carries `tickets:<pillar>:update`. Costs one extra round-trip;
  // acceptable because tickets are low-volume and this is the safe-
  // by-default posture.
  const { data: existing, error: fetchErr } = await adminClient()
    .from("tickets")
    .select("pillar")
    .eq("id", id)
    .eq("namespace", ctx.userId)
    .maybeSingle();
  if (fetchErr) return json({ error: "fetch_failed", detail: fetchErr.message });
  if (!existing) return json({ error: "ticket_not_found", id });
  const required = `tickets:${existing.pillar}:update`;
  if (!hasScope(ctx.scope, required)) {
    return json({ error: "scope_denied", required, tool: "update_ticket", pillar: existing.pillar });
  }

  patch.updated_at = new Date().toISOString();

  const { data, error } = await adminClient()
    .from("tickets")
    .update(patch)
    .eq("id", id)
    .eq("namespace", ctx.userId)
    .select("id, namespace, pillar, type, status, priority, payload, created_at, updated_at, resolved_at, first_resolved_at")
    .single();

  if (error) {
    // Postgrest returns PGRST116 when .single() sees zero rows — treat
    // as not_found so the caller can distinguish it from a real DB
    // failure.
    if (error.code === "PGRST116") return json({ error: "ticket_not_found", id });
    return json({ error: "update_failed", detail: error.message });
  }
  return json({ ok: true, ticket: data });
}
