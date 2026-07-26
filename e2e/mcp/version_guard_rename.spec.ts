// SPRINT-141c: source-doc version-guard on rename_doc.

import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renameDoc } from "@/src/lib/mcp/tools/rename_doc";
import { hashBody } from "@/src/lib/mcp/tools/sections";
import { localToolContext } from "@/src/lib/mcp/tools/context";

interface ToolCallResult { content: Array<{ type: "text"; text: string }>; }
function parse(raw: unknown): Record<string, unknown> {
  const r = raw as ToolCallResult;
  return JSON.parse(r.content[0].text) as Record<string, unknown>;
}

const STALE = "0000000000000000";

test.describe("rename_doc source guard (SPRINT-141c)", () => {
  let docsDir: string;
  test.beforeEach(() => {
    docsDir = join(tmpdir(), `emdee-renameguard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(docsDir, { recursive: true });
  });
  test.afterEach(() => {
    try { rmSync(docsDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test("stale hash on source → conflict", async () => {
    writeFileSync(join(docsDir, "OLD.md"), "# Old Title\n\n## Notes\n");
    const ctx = localToolContext(docsDir);
    const stale = parse(await renameDoc(ctx, {
      old_path: "OLD.md", new_title: "New Title",
      expected_content_hash: STALE,
    }));
    expect(stale.error).toBe("stale_content");
    expect(stale.path).toBe("OLD.md");
  });

  test("fresh hash on source → proceeds (or fails on a non-guard error)", async () => {
    const content = "# Old Title\n\n## Notes\n";
    writeFileSync(join(docsDir, "OLD.md"), content);
    const ctx = localToolContext(docsDir);
    const r = parse(await renameDoc(ctx, {
      old_path: "OLD.md", new_title: "New Title",
      expected_content_hash: hashBody(content),
    }));
    expect(r.error).not.toBe("stale_content");
  });
});
