// SPRINT-140: reconcile runs in both cloud AND local modes now.
// This spec exercises local mode against a temp docs tree.

import { expect, test } from "@playwright/test";
import { reconcile } from "@/src/lib/mcp/tools/reconcile";
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

test.describe("reconcile (SPRINT-140 local mode)", () => {
  let docsDir: string;

  test.beforeEach(() => {
    docsDir = join(tmpdir(), `emdee-reconcile-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(docsDir, { recursive: true });
  });

  test.afterEach(() => {
    try { rmSync(docsDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test("requires path OR all", async () => {
    writeFileSync(join(docsDir, "x.md"), "# X\n\n## Notes\n");
    const ctx = localToolContext(docsDir);
    const body = parse(await reconcile(ctx, {}));
    expect(body.error).toBe("path_or_all_required");
  });

  test("refuses --path and --all together", async () => {
    writeFileSync(join(docsDir, "x.md"), "# X\n\n## Notes\n");
    const ctx = localToolContext(docsDir);
    const body = parse(await reconcile(ctx, { path: "x.md", all: true }));
    expect(body.error).toBe("path_and_all_conflict");
  });

  test("--all rebuilds local doc_edges from filesystem truth", async () => {
    writeFileSync(join(docsDir, "ROOT.md"), "# ROOT\n\n## Parent of\n\n* [[Child]]\n");
    writeFileSync(join(docsDir, "child.md"), "# Child\n\n## Child of\n\n* [[ROOT]]\n");
    const ctx = localToolContext(docsDir);
    const body = parse(await reconcile(ctx, { all: true }));
    expect(body.ok).toBe(true);
    expect(body.mode).toBe("namespace");
    expect(body.docs_scanned as number).toBeGreaterThanOrEqual(2);
    expect(body.edges_written as number).toBeGreaterThanOrEqual(1);
  });
});
