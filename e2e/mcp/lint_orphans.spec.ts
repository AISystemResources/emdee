// SPRINT-140: lint_orphans runs in both cloud AND local modes now.
// This spec exercises the local-mode path end-to-end: build a temp docs
// tree with a known orphan, run the tool, verify the classification.
//
// The cloud-mode path shares the exact same code (VaultDatabase
// abstraction), so covering local is sufficient for the CI gate.

import { expect, test } from "@playwright/test";
import { lintOrphans } from "@/src/lib/mcp/tools/lint_orphans";
import { localToolContext } from "@/src/lib/mcp/tools/context";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

interface ToolCallResult { content: Array<{ type: "text"; text: string }>; }

function parse(raw: unknown): Record<string, unknown> {
  const r = raw as ToolCallResult;
  expect(r.content?.[0]?.type).toBe("text");
  return JSON.parse(r.content[0].text) as Record<string, unknown>;
}

test.describe("lint_orphans (SPRINT-140 local mode)", () => {
  let docsDir: string;

  test.beforeEach(() => {
    docsDir = join(tmpdir(), `emdee-lint-orphans-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(docsDir, { recursive: true });
  });

  test.afterEach(() => {
    try { rmSync(docsDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test("detects a structural orphan in local mode", async () => {
    // Root doc + one orphan (no ## Child of section).
    writeFileSync(join(docsDir, "ROOT.md"), "# ROOT\n\n## Parent of\n\n* [[Child A]]\n\n## Notes\n");
    writeFileSync(join(docsDir, "child-a.md"), "# Child A\n\n## Child of\n\n* [[ROOT]]\n\n## Notes\n");
    writeFileSync(join(docsDir, "orphan.md"), "# Orphan Doc\n\n## Notes\n\nI have no parent.\n");

    const ctx = localToolContext(docsDir);
    const result = parse(await lintOrphans(ctx, {}));
    expect(result.ok).toBe(true);
    const byKind = result.by_kind as Record<string, number>;
    expect(byKind.structural_orphan).toBeGreaterThanOrEqual(1);
    const orphans = result.orphans as Array<{ path: string; kind: string }>;
    const orphanPaths = orphans.filter((o) => o.kind === "structural_orphan").map((o) => o.path);
    expect(orphanPaths).toContain("orphan.md");
  });
});
