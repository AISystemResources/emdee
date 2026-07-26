// SPRINT-092 HARD RULE 11 spec: strict argument validation on write tools.
//
// The MCP SDK doesn't validate tool `arguments` against `inputSchema`, so a
// wrong-param typo (`new_body` instead of `body`) used to silently no-op or,
// worse, wipe a section. `validateArgs` runs first inside every write tool
// and returns a loud error envelope instead. This spec covers three tool
// families (patch_section, append_section, create_child) to confirm both
// unknown-arg + missing-required paths hit as expected.

import { expect, test } from "@playwright/test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { patchSection } from "@/src/lib/mcp/tools/patch_section";
import { appendSection } from "@/src/lib/mcp/tools/append_section";
import { createChild } from "@/src/lib/mcp/tools/create_child";
import type { ToolContext } from "@/src/lib/mcp/tools/types";
import { localToolContext } from "@/src/lib/mcp/tools/context";

interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
}
function parseJson(raw: unknown): Record<string, unknown> {
  const r = raw as ToolCallResult;
  expect(r.content?.[0]?.type).toBe("text");
  return JSON.parse(r.content[0].text);
}

const ALPHA = `# ALPHA\n\n> First doc.\n\n## Notes\n\nBody.\n`;

test.describe("write-tool argument validation (SPRINT-092)", () => {
  let docsDir: string;
  let ctx: ToolContext;

  test.beforeEach(async () => {
    docsDir = await mkdtemp(path.join(tmpdir(), "emdee-argval-"));
    await writeFile(path.join(docsDir, "ALPHA.md"), ALPHA, "utf8");
    ctx = localToolContext(docsDir);
  });

  test.afterEach(async () => {
    await rm(docsDir, { recursive: true, force: true });
  });

  test("patch_section rejects an unknown parameter name (the empty-write wipe footgun)", async () => {
    const out = parseJson(
      await patchSection(ctx, {
        path: "ALPHA.md",
        section_id: "abc",
        new_body: "hello", // wrong — real key is `body`
        expected_content_hash: "deadbeef",
      } as unknown as Record<string, unknown>),
    );
    expect(out.error).toBe("unknown_arguments");
    expect(out.unknown).toEqual(["new_body"]);
    expect((out.allowed as string[]) ?? []).toContain("body");
  });

  test("append_section rejects when required `body` is missing", async () => {
    const out = parseJson(
      await appendSection(ctx, {
        path: "ALPHA.md",
        heading: "Notes",
      }),
    );
    expect(out.error).toBe("missing_required");
    expect(out.missing).toContain("body");
  });

  test("create_child rejects an unknown parameter name", async () => {
    const out = parseJson(
      await createChild(ctx, {
        parent_path: "ALPHA.md",
        title: "BETA",
        contents: "hello", // wrong — real key is `body`
      } as unknown as Record<string, unknown>),
    );
    expect(out.error).toBe("unknown_arguments");
    expect(out.unknown).toEqual(["contents"]);
  });

  test("patch_section still works with correct args (sanity check — validator doesn't false-positive)", async () => {
    // Read ALPHA's Notes section hash first via a real call chain would be
    // complex; simplest check: pass a bogus hash, expect version_conflict,
    // NOT unknown_arguments — proves the validator didn't block a good call.
    const out = parseJson(
      await patchSection(ctx, {
        path: "ALPHA.md",
        heading: "Notes",
        body: "new body",
        expected_content_hash: "0000000000000000",
      }),
    );
    expect(out.error).toBe("version_conflict");
  });
});
