import { adminClient } from "../../supabase/admin";
import type { ToolContext } from "./types";
import { hasScope } from "../scopes";

// SPRINT-173: cross-project ticket queue — create verb.
// Cloud-only: tickets live in Postgres, not the vault filesystem, so
// stdio/local sessions have nothing meaningful to write against.

const PILLARS = ["cmo", "cpo", "coo", "ceo"] as const;
const PRIORITIES = ["low", "medium", "high"] as const;

type Pillar = (typeof PILLARS)[number];
type Priority = (typeof PRIORITIES)[number];

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

// SPRINT-185: normalise an optional agent-id slug. Returns undefined
// (absent), a trimmed non-empty string (valid), or "invalid" sentinel
// if the caller passed a non-string, empty, or oversized value.
function optionalSlug(v: unknown): string | undefined | "invalid" {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") return "invalid";
  const trimmed = v.trim();
  if (trimmed.length === 0) return "invalid";
  if (trimmed.length > 128) return "invalid";
  return trimmed;
}

export async function createTicket(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  if (ctx.mode !== "cloud") {
    return json({ error: "cloud_mode_required", hint: "create_ticket runs against Supabase; no local implementation." });
  }

  const pillar = typeof args.pillar === "string" ? args.pillar.toLowerCase() : "";
  if (!(PILLARS as readonly string[]).includes(pillar)) {
    return json({ error: "invalid_pillar", allowed: PILLARS });
  }

  // SPRINT-178: pillar-specific scope check. mcp superuser passes; a
  // token with tickets:<pillar>:create can only create on that pillar.
  const required = `tickets:${pillar}:create`;
  if (!hasScope(ctx.scope, required)) {
    return json({ error: "scope_denied", required, tool: "create_ticket", pillar });
  }

  const type = typeof args.type === "string" ? args.type.trim() : "";
  if (type.length === 0) return json({ error: "type_required" });
  if (type.length > 128) return json({ error: "type_too_long", max: 128 });

  const priority = typeof args.priority === "string" ? args.priority.toLowerCase() : "medium";
  if (!(PRIORITIES as readonly string[]).includes(priority)) {
    return json({ error: "invalid_priority", allowed: PRIORITIES });
  }

  let payload: Record<string, unknown> = {};
  if (args.payload !== undefined && args.payload !== null) {
    const rec = asRecord(args.payload);
    if (!rec) return json({ error: "invalid_payload", hint: "payload must be a JSON object" });
    payload = rec;
  }

  // SPRINT-185: optional agent addressing. Opaque string slug (convention
  // "project:role", e.g. "whatelz:cmo") — enforced at the prompt / vault
  // layer, not the schema. NULL when the caller uses pillar-only routing.
  const assignedAgentId = optionalSlug(args.assigned_agent_id);
  const senderAgentId = optionalSlug(args.sender_agent_id);
  if (assignedAgentId === "invalid") return json({ error: "invalid_assigned_agent_id", hint: "must be non-empty string, max 128 chars" });
  if (senderAgentId === "invalid") return json({ error: "invalid_sender_agent_id", hint: "must be non-empty string, max 128 chars" });

  const { data, error } = await adminClient()
    .from("tickets")
    .insert({
      namespace: ctx.userId,
      pillar: pillar as Pillar,
      type,
      priority: priority as Priority,
      payload,
      assigned_agent_id: assignedAgentId ?? null,
      sender_agent_id: senderAgentId ?? null,
    })
    .select("id, namespace, pillar, type, status, priority, payload, assigned_agent_id, sender_agent_id, created_at, updated_at, resolved_at, first_resolved_at")
    .single();

  if (error) return json({ error: "insert_failed", detail: error.message });
  return json({ ok: true, ticket: data });
}
