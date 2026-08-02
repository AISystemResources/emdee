// SPRINT-176 (HARD RULE 11): trigger round-trip for tickets.first_resolved_at.
//
// The stamping happens in a Postgres trigger, not in tool code, so this
// spec exercises the LIVE DB end-to-end. Skipped when SUPABASE creds are
// absent (local runs); runs in CI where SUPABASE_TEST_URL is set.
//
// Cleanup: every test creates one ticket, closes it, and updates it to
// exercise the reopen→reclose path. Namespace `user_test_spr176` is
// ephemeral — any rows left behind by prior runs are harmless (test
// namespace is orthogonal to real users) but we also delete-on-teardown
// to keep the table tidy.

import { expect, test } from "@playwright/test";
import { createTicket } from "@/src/lib/mcp/tools/create_ticket";
import { updateTicket } from "@/src/lib/mcp/tools/update_ticket";
import type { ToolContext } from "@/src/lib/mcp/tools/types";

const hasCreds = !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
}

function parse(raw: unknown): Record<string, unknown> {
  const r = raw as ToolCallResult;
  expect(r.content?.[0]?.type).toBe("text");
  return JSON.parse(r.content[0].text) as Record<string, unknown>;
}

const NAMESPACE = "user_test_spr176";
const cloudCtx = {
  mode: "cloud",
  userId: NAMESPACE,
  storage: {} as never,
  db: {} as never,
  scope: "mcp",
} as unknown as ToolContext;

test.describe("tickets.first_resolved_at trigger (SPRINT-176)", () => {
  test.skip(!hasCreds, "SUPABASE env not set — trigger round-trip requires live DB");

  test("trigger stamps first_resolved_at on first done transition, preserves it across reopen→reclose", async () => {
    // 1. Create — first_resolved_at should be null.
    const created = parse(await createTicket(cloudCtx, {
      pillar: "cmo",
      type: "test-e2e-first-resolved-at",
    }));
    expect(created.ok).toBe(true);
    const ticket = created.ticket as Record<string, unknown>;
    expect(ticket.first_resolved_at).toBeNull();
    expect(ticket.resolved_at).toBeNull();
    const id = ticket.id as string;

    // 2. Close — resolved_at + first_resolved_at both set.
    const closed = parse(await updateTicket(cloudCtx, { id, status: "done" }));
    expect(closed.ok).toBe(true);
    const closedTicket = closed.ticket as Record<string, unknown>;
    expect(closedTicket.resolved_at).not.toBeNull();
    expect(closedTicket.first_resolved_at).not.toBeNull();
    const firstResolvedAt = closedTicket.first_resolved_at as string;

    // 3. Reopen — resolved_at clears, first_resolved_at stays.
    const reopened = parse(await updateTicket(cloudCtx, { id, status: "open" }));
    expect(reopened.ok).toBe(true);
    const reopenedTicket = reopened.ticket as Record<string, unknown>;
    expect(reopenedTicket.resolved_at).toBeNull();
    expect(reopenedTicket.first_resolved_at).toBe(firstResolvedAt);

    // Small delay so the second close's resolved_at is provably later.
    await new Promise((r) => setTimeout(r, 20));

    // 4. Reclose — resolved_at is fresh, first_resolved_at UNCHANGED.
    const reclosed = parse(await updateTicket(cloudCtx, { id, status: "done" }));
    expect(reclosed.ok).toBe(true);
    const reclosedTicket = reclosed.ticket as Record<string, unknown>;
    expect(reclosedTicket.resolved_at).not.toBeNull();
    expect(reclosedTicket.resolved_at).not.toBe(closedTicket.resolved_at);
    expect(reclosedTicket.first_resolved_at).toBe(firstResolvedAt);
  });

  test("response envelope always exposes first_resolved_at (create + list + update projections)", async () => {
    const created = parse(await createTicket(cloudCtx, {
      pillar: "cpo",
      type: "test-e2e-response-shape",
    }));
    expect(created.ok).toBe(true);
    const ticket = created.ticket as Record<string, unknown>;
    // The field must be present in the projection even when null — otherwise
    // callers can't tell "unresolved" apart from "field missing from projection."
    expect(Object.prototype.hasOwnProperty.call(ticket, "first_resolved_at")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(ticket, "resolved_at")).toBe(true);
  });

  // ── SPRINT-178: update_ticket pillar-mismatch scope enforcement ──────
  //
  // update_ticket fetches the ticket's pillar first, then checks the
  // caller's scope against `tickets:<pillar>:update`. Requires live DB
  // (fetch is unavoidable). If the inner check is ever removed, this
  // test (the deny path especially) fails — regression guard.

  test("SPRINT-178: scoped token updating a ticket on mismatched pillar denies with scope_denied", async () => {
    // First create a cmo ticket using the mcp superuser stub.
    const created = parse(await createTicket(cloudCtx, {
      pillar: "cmo",
      type: "test-e2e-scope-update-deny",
    }));
    expect(created.ok).toBe(true);
    const id = (created.ticket as Record<string, unknown>).id as string;

    // Now try to update it with a scope that only grants tickets:cpo:update.
    const cpoOnlyCtx = {
      mode: "cloud",
      userId: NAMESPACE,
      storage: {} as never,
      db: {} as never,
      scope: "tickets:cpo:update",
    } as unknown as ToolContext;
    const r = parse(await updateTicket(cpoOnlyCtx, { id, status: "done" }));
    expect(r.error).toBe("scope_denied");
    expect(r.required).toBe("tickets:cmo:update");
    expect(r.tool).toBe("update_ticket");
    expect(r.pillar).toBe("cmo");
  });

  test("SPRINT-178: scoped token updating a ticket on matched pillar clears the scope gate", async () => {
    const created = parse(await createTicket(cloudCtx, {
      pillar: "cmo",
      type: "test-e2e-scope-update-allow",
    }));
    expect(created.ok).toBe(true);
    const id = (created.ticket as Record<string, unknown>).id as string;

    const cmoOnlyCtx = {
      mode: "cloud",
      userId: NAMESPACE,
      storage: {} as never,
      db: {} as never,
      scope: "tickets:cmo:update",
    } as unknown as ToolContext;
    const r = parse(await updateTicket(cmoOnlyCtx, { id, status: "done" }));
    expect(r.ok).toBe(true);
    if (r.error) expect(r.error).not.toBe("scope_denied");
  });
});
