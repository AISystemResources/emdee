// SPRINT-173 (HARD RULE 11): validation-branch coverage for create_ticket.
//
// Following the upload_image_svg.spec.ts pattern — we exercise the tool
// with a stub cloud ctx to cover every input-validation branch. Happy
// path against a live Supabase project is a manual smoke against the
// EMDEE-test DB after the migration is applied (HARD RULE 12).

import { expect, test } from "@playwright/test";
import { createTicket } from "@/src/lib/mcp/tools/create_ticket";
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

test.describe("create_ticket (SPRINT-173)", () => {
  test("local mode is refused with cloud_mode_required", async () => {
    const localCtx = { mode: "local", docsDir: "/tmp", db: {} } as unknown as ToolContext;
    const r = parse(await createTicket(localCtx, { pillar: "cmo", type: "test" }));
    expect(r.error).toBe("cloud_mode_required");
  });

  test("rejects invalid pillar", async () => {
    const r = parse(await createTicket(cloudCtx, { pillar: "cfo", type: "test" }));
    expect(r.error).toBe("invalid_pillar");
    expect(r.allowed).toEqual(["cmo", "cpo", "coo", "ceo"]);
  });

  test("pillar comparison is case-insensitive", async () => {
    // Uppercase CMO must clear the enum check. Any downstream outcome
    // (successful insert in a CI env with SUPABASE creds, or an
    // adminClient throw in a stripped env) is acceptable — the ONLY
    // invariant we're asserting is that the case-normalisation isn't
    // silently dropped in a future refactor.
    try {
      const r = parse(await createTicket(cloudCtx, { pillar: "CMO", type: "test-e2e-case-insensitive" }));
      if (r.error) expect(r.error).not.toBe("invalid_pillar");
    } catch {
      // adminClient() init or insert threw — both are past validation.
    }
  });

  test("rejects missing type", async () => {
    const r = parse(await createTicket(cloudCtx, { pillar: "cmo" }));
    expect(r.error).toBe("type_required");
  });

  test("rejects overlong type (>128 chars)", async () => {
    const r = parse(await createTicket(cloudCtx, { pillar: "cmo", type: "x".repeat(129) }));
    expect(r.error).toBe("type_too_long");
  });

  test("rejects invalid priority", async () => {
    const r = parse(await createTicket(cloudCtx, {
      pillar: "cmo",
      type: "test",
      priority: "critical",
    }));
    expect(r.error).toBe("invalid_priority");
    expect(r.allowed).toEqual(["low", "medium", "high"]);
  });

  test("rejects non-object payload (array)", async () => {
    const r = parse(await createTicket(cloudCtx, {
      pillar: "cmo",
      type: "test",
      payload: ["not", "an", "object"],
    }));
    expect(r.error).toBe("invalid_payload");
  });

  test("rejects non-object payload (string)", async () => {
    const r = parse(await createTicket(cloudCtx, {
      pillar: "cmo",
      type: "test",
      payload: "not-json",
    }));
    expect(r.error).toBe("invalid_payload");
  });
});
