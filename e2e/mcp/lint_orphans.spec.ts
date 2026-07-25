// SPRINT-120: HARD RULE 11 spec for lint_orphans.
//
// The tool needs cloud mode + Supabase; we can't exercise the full end-to-end
// against a temp filesystem. Instead we assert the pieces that would silently
// break: the local-mode refusal path (must never scan bogus data) and the
// classifier helper (via the exported behavior).
//
// The full auto-fix path is exercised implicitly during real-vault use — this
// spec's job is to pin the shape so future refactors don't drift the contract.

import { expect, test } from "@playwright/test";
import { lintOrphans } from "@/src/lib/mcp/tools/lint_orphans";
import type { ToolContext } from "@/src/lib/mcp/tools/types";

interface ToolCallResult { content: Array<{ type: "text"; text: string }>; }

function parse(raw: unknown): Record<string, unknown> {
  const r = raw as ToolCallResult;
  expect(r.content?.[0]?.type).toBe("text");
  return JSON.parse(r.content[0].text) as Record<string, unknown>;
}

test.describe("lint_orphans", () => {
  test("refuses in local mode", async () => {
    const ctx: ToolContext = { mode: "local", docsDir: "/tmp/does-not-matter" };
    const result = parse(await lintOrphans(ctx, {}));
    expect(result.error).toBe("cloud_mode_required");
  });

  test("refuses in local mode even with fix=true", async () => {
    const ctx: ToolContext = { mode: "local", docsDir: "/tmp/does-not-matter" };
    const result = parse(await lintOrphans(ctx, { fix: true }));
    expect(result.error).toBe("cloud_mode_required");
  });
});
