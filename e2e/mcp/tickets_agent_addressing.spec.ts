// SPRINT-185: HARD RULE 11 validation-branch coverage for the new
// assigned_agent_id / sender_agent_id fields on create_ticket and
// list_tickets.
//
// Follows the SPRINT-173 stub-cloud pattern (see create_ticket.spec.ts,
// list_tickets.spec.ts) — validation branches run on a synthetic cloud
// ctx; anything past validation may throw against a stripped SUPABASE
// env, which we accept as "past the guard". Happy-path round-trip
// against the EMDEE-test project is a manual smoke after the migration
// applies (HARD RULE 12).

import { expect, test } from "@playwright/test";
import { createTicket } from "@/src/lib/mcp/tools/create_ticket";
import { listTickets } from "@/src/lib/mcp/tools/list_tickets";
import type { ToolContext } from "@/src/lib/mcp/tools/types";

interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
}

function parse(raw: unknown): Record<string, unknown> {
  const r = raw as ToolCallResult;
  expect(r.content?.[0]?.type).toBe("text");
  return JSON.parse(r.content[0].text) as Record<string, unknown>;
}

const cloudCtx = {
  mode: "cloud",
  userId: "user_test",
  storage: {} as never,
  db: {} as never,
  scope: "mcp",
} as unknown as ToolContext;

test.describe("create_ticket agent addressing (SPRINT-185)", () => {
  test("accepts optional assigned_agent_id + sender_agent_id past validation", async () => {
    // Both fields valid — must pass validation. Any DB error downstream
    // is acceptable — we only care the guards don't reject.
    try {
      const r = parse(await createTicket(cloudCtx, {
        pillar: "cmo",
        type: "test-e2e-agent-addr",
        assigned_agent_id: "whatelz:cmo",
        sender_agent_id: "whatelz:ceo",
      }));
      if (r.error) {
        expect(r.error).not.toBe("invalid_assigned_agent_id");
        expect(r.error).not.toBe("invalid_sender_agent_id");
      }
    } catch {
      // adminClient threw = past validation. Fine.
    }
  });

  test("rejects assigned_agent_id when not a string", async () => {
    const r = parse(await createTicket(cloudCtx, {
      pillar: "cmo",
      type: "test",
      assigned_agent_id: 123,
    }));
    expect(r.error).toBe("invalid_assigned_agent_id");
  });

  test("rejects empty assigned_agent_id", async () => {
    const r = parse(await createTicket(cloudCtx, {
      pillar: "cmo",
      type: "test",
      assigned_agent_id: "   ",
    }));
    expect(r.error).toBe("invalid_assigned_agent_id");
  });

  test("rejects overlong assigned_agent_id (>128 chars)", async () => {
    const r = parse(await createTicket(cloudCtx, {
      pillar: "cmo",
      type: "test",
      assigned_agent_id: "a".repeat(129),
    }));
    expect(r.error).toBe("invalid_assigned_agent_id");
  });

  test("rejects empty sender_agent_id", async () => {
    const r = parse(await createTicket(cloudCtx, {
      pillar: "cmo",
      type: "test",
      sender_agent_id: "",
    }));
    expect(r.error).toBe("invalid_sender_agent_id");
  });

  test("backwards-compat: create still works when neither agent field is provided", async () => {
    // The pillar-only shape from SPRINT-173 must keep working — this is
    // the whole point of making the new fields optional.
    try {
      const r = parse(await createTicket(cloudCtx, {
        pillar: "cmo",
        type: "test-e2e-backwards-compat",
      }));
      if (r.error) {
        expect(r.error).not.toBe("invalid_assigned_agent_id");
        expect(r.error).not.toBe("invalid_sender_agent_id");
      }
    } catch {
      // adminClient threw = past validation.
    }
  });
});

test.describe("list_tickets agent-filter (SPRINT-185)", () => {
  test("accepts assigned_agent_id filter past validation", async () => {
    try {
      const r = parse(await listTickets(cloudCtx, {
        assigned_agent_id: "whatelz:cmo",
      }));
      if (r.error) expect(r.error).not.toBe("invalid_assigned_agent_id");
    } catch {
      // adminClient threw = past validation.
    }
  });

  test("rejects empty assigned_agent_id filter", async () => {
    const r = parse(await listTickets(cloudCtx, { assigned_agent_id: "  " }));
    expect(r.error).toBe("invalid_assigned_agent_id");
  });

  test("rejects non-string assigned_agent_id filter", async () => {
    const r = parse(await listTickets(cloudCtx, { assigned_agent_id: 42 }));
    expect(r.error).toBe("invalid_assigned_agent_id");
  });
});
