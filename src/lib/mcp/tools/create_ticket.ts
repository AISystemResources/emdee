import { adminClient } from "../../supabase/admin";
import type { ToolContext } from "./types";

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

export async function createTicket(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  if (ctx.mode !== "cloud") {
    return json({ error: "cloud_mode_required", hint: "create_ticket runs against Supabase; no local implementation." });
  }

  const pillar = typeof args.pillar === "string" ? args.pillar.toLowerCase() : "";
  if (!(PILLARS as readonly string[]).includes(pillar)) {
    return json({ error: "invalid_pillar", allowed: PILLARS });
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

  const { data, error } = await adminClient()
    .from("tickets")
    .insert({
      namespace: ctx.userId,
      pillar: pillar as Pillar,
      type,
      priority: priority as Priority,
      payload,
    })
    .select("id, namespace, pillar, type, status, priority, payload, created_at, updated_at, resolved_at, first_resolved_at")
    .single();

  if (error) return json({ error: "insert_failed", detail: error.message });
  return json({ ok: true, ticket: data });
}
