// SPRINT-180: HARD RULE 11 spec for patch_section hierarchy hard-guard.
//
// SPRINT-136 shipped a soft-warning ("relationship_section_patched") on
// writes to `## Child of` / `## Parent of` / `## Associated with` — the
// most common source of asymmetric-edge drift. SPRINT-180 promotes it to
// a hard-refuse: the write is rejected unless the caller opts in with
// `force_relationship_write: true`. This spec covers both paths and the
// unchanged happy path on a non-relationship section.
//
// Local-mode exercise per SPRINT-054 pattern.

import { expect, test } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { patchSection } from "@/src/lib/mcp/tools/patch_section";
import type { ToolContext } from "@/src/lib/mcp/tools/types";
import { localToolContext } from "@/src/lib/mcp/tools/context";

interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
}

function parseToolResult(raw: unknown): Record<string, unknown> {
  const result = raw as ToolCallResult;
  expect(result.content?.[0]?.type).toBe("text");
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

// Mirror hashBody in src/lib/mcp/tools/sections.ts — first 16 hex chars
// of sha256 over the body-trimmed string. Kept inline so the spec has
// zero coupling to internal helpers beyond the tool entry point.
function hashBody(body: string): string {
  return createHash("sha256").update(body.trim()).digest("hex").slice(0, 16);
}

const DOC_CONTENT = `# TARGET

> A doc with relationship sections and a plain notes section.

## Child of

* [[OLD-PARENT]]

## Parent of

## Associated with

## Notes

original notes body
`;

test.describe("patch_section hierarchy hard-guard (SPRINT-180)", () => {
  let docsDir: string;
  let ctx: ToolContext;

  test.beforeEach(async () => {
    docsDir = await mkdtemp(path.join(tmpdir(), "emdee-patch-guard-"));
    await mkdir(docsDir, { recursive: true });
    await writeFile(path.join(docsDir, "TARGET.md"), DOC_CONTENT, "utf8");
    ctx = localToolContext(docsDir);
  });

  test.afterEach(async () => {
    await rm(docsDir, { recursive: true, force: true });
  });

  test("refuses a write to `Child of` without the escape hatch", async () => {
    const priorHash = hashBody("* [[OLD-PARENT]]");
    const raw = await patchSection(ctx, {
      path: "TARGET.md",
      heading: "Child of",
      body: "* [[NEW-PARENT]]",
      expected_content_hash: priorHash,
    });
    const result = parseToolResult(raw);
    expect(result.error).toBe("hierarchy_section_write_refused");
    expect(result.kind).toBe("hierarchy");
    expect(result.atomic_tool).toContain("move_doc");

    // File on disk must be unchanged.
    const onDisk = await readFile(path.join(docsDir, "TARGET.md"), "utf8");
    expect(onDisk).toBe(DOC_CONTENT);
  });

  test("refuses a write to `Associated with` without the escape hatch", async () => {
    const priorHash = hashBody("");
    const raw = await patchSection(ctx, {
      path: "TARGET.md",
      heading: "Associated with",
      body: "* [[COUSIN]]",
      expected_content_hash: priorHash,
    });
    const result = parseToolResult(raw);
    expect(result.error).toBe("hierarchy_section_write_refused");
    expect(result.kind).toBe("assoc");
    expect(result.atomic_tool).toContain("add_association");
  });

  test("allows the write when force_relationship_write=true, and surfaces a forced-write warning", async () => {
    const priorHash = hashBody("* [[OLD-PARENT]]");
    const raw = await patchSection(ctx, {
      path: "TARGET.md",
      heading: "Child of",
      body: "* [[NEW-PARENT]]",
      expected_content_hash: priorHash,
      force_relationship_write: true,
    });
    const result = parseToolResult(raw);
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();

    const warnings = result.warnings as Array<{ code: string }> | undefined;
    expect(warnings?.some((w) => w.code === "relationship_section_forced_write")).toBe(true);

    // File on disk should now carry the new bullet.
    const onDisk = await readFile(path.join(docsDir, "TARGET.md"), "utf8");
    expect(onDisk).toContain("[[NEW-PARENT]]");
    expect(onDisk).not.toContain("[[OLD-PARENT]]");
  });

  test("leaves plain (non-relationship) sections working exactly as before", async () => {
    const priorHash = hashBody("original notes body");
    const raw = await patchSection(ctx, {
      path: "TARGET.md",
      heading: "Notes",
      body: "revised notes body",
      expected_content_hash: priorHash,
    });
    const result = parseToolResult(raw);
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();

    const onDisk = await readFile(path.join(docsDir, "TARGET.md"), "utf8");
    expect(onDisk).toContain("revised notes body");
    expect(onDisk).not.toContain("original notes body");
  });
});
