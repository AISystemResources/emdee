// SPRINT-173 (HARD RULE 11): validation-branch coverage for update_ticket.

import { expect, test } from "@playwright/test";
import { updateTicket } from "@/src/lib/mcp/tools/update_ticket";
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

test.describe("update_ticket (SPRINT-173)", () => {
  test("local mode is refused with cloud_mode_required", async () => {
    const localCtx = { mode: "local", docsDir: "/tmp", db: {} } as unknown as ToolContext;
    const r = parse(await updateTicket(localCtx, { id: "x", status: "done" }));
    expect(r.error).toBe("cloud_mode_required");
  });

  test("rejects missing id", async () => {
    const r = parse(await updateTicket(cloudCtx, { status: "done" }));
    expect(r.error).toBe("id_required");
  });

  test("rejects empty id", async () => {
    const r = parse(await updateTicket(cloudCtx, { id: "   ", status: "done" }));
    expect(r.error).toBe("id_required");
  });

  test("rejects invalid status", async () => {
    const r = parse(await updateTicket(cloudCtx, { id: "abc", status: "resolved" }));
    expect(r.error).toBe("invalid_status");
  });

  test("rejects invalid priority", async () => {
    const r = parse(await updateTicket(cloudCtx, { id: "abc", priority: "critical" }));
    expect(r.error).toBe("invalid_priority");
  });

  test("rejects non-object payload", async () => {
    const r = parse(await updateTicket(cloudCtx, { id: "abc", payload: "nope" }));
    expect(r.error).toBe("invalid_payload");
  });

  test("rejects update with only id (no patch fields)", async () => {
    const r = parse(await updateTicket(cloudCtx, { id: "abc" }));
    expect(r.error).toBe("no_updatable_fields");
  });
});
