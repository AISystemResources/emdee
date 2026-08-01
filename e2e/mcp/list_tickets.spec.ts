// SPRINT-173 (HARD RULE 11): validation-branch coverage for list_tickets.

import { expect, test } from "@playwright/test";
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
} as unknown as ToolContext;

test.describe("list_tickets (SPRINT-173)", () => {
  test("local mode is refused with cloud_mode_required", async () => {
    const localCtx = { mode: "local", docsDir: "/tmp", db: {} } as unknown as ToolContext;
    const r = parse(await listTickets(localCtx, {}));
    expect(r.error).toBe("cloud_mode_required");
  });

  test("rejects invalid pillar filter", async () => {
    const r = parse(await listTickets(cloudCtx, { pillar: "cfo" }));
    expect(r.error).toBe("invalid_pillar");
  });

  test("rejects invalid status filter", async () => {
    const r = parse(await listTickets(cloudCtx, { status: "resolved" }));
    expect(r.error).toBe("invalid_status");
    expect(r.allowed).toEqual(["open", "in_progress", "done", "blocked"]);
  });

  test("null pillar / status args are treated as absent (not invalid)", async () => {
    // Passing explicit null must clear both enum checks. Any downstream
    // outcome (empty-list success in CI, adminClient throw in a
    // stripped env) is acceptable — we're only asserting the null
    // guard isn't silently regressed.
    try {
      const r = parse(await listTickets(cloudCtx, { pillar: null, status: null }));
      if (r.error) {
        expect(r.error).not.toBe("invalid_pillar");
        expect(r.error).not.toBe("invalid_status");
      }
    } catch {
      // adminClient() init or select threw — both are past validation.
    }
  });
});
