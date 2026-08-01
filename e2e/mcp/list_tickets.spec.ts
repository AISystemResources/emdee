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
    // Passing null explicitly should not surface invalid_pillar / _status
    // — it should behave as if the filter wasn't passed. The call may
    // still fail at the DB layer (missing env) but past validation is
    // what we assert.
    let r: Record<string, unknown> | null = null;
    let thrown: unknown = null;
    try {
      r = parse(await listTickets(cloudCtx, { pillar: null, status: null }));
    } catch (e) {
      thrown = e;
    }
    if (r && r.error) {
      expect(r.error).not.toBe("invalid_pillar");
      expect(r.error).not.toBe("invalid_status");
    } else {
      expect(thrown).toBeTruthy();
    }
  });
});
