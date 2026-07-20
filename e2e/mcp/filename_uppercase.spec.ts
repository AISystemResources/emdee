// SPRINT-055 (SIG-004): HARD RULE 11 spec for filename uppercase enforcement.
//
// Exercises three surfaces against a local-mode ToolContext + temp filesystem:
// 1. `lint_doc` emits `filename_not_uppercase` for lowercase basenames
// 2. `write_doc` refuses non-uppercase paths with a structured fix-suggestion
// 3. `create_child` auto-uppercases title-derived filenames

import { expect, test } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeDoc } from "@/src/lib/mcp/tools/write_doc";
import { createChild } from "@/src/lib/mcp/tools/create_child";
import { lintDoc } from "@/src/lib/mcp/tools/lint_doc";
import type { ToolContext } from "@/src/lib/mcp/tools/types";

interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
}

function parseToolResult(raw: unknown): Record<string, unknown> {
  const result = raw as ToolCallResult;
  expect(result.content?.[0]?.type).toBe("text");
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

const PARENT_CONTENT = `# PARENT

> A parent doc.

## Child of

* [[ROOT]]

## Parent of
`;

test.describe("filename uppercase enforcement (local-mode)", () => {
  let docsDir: string;
  let ctx: ToolContext;

  test.beforeEach(async () => {
    docsDir = await mkdtemp(path.join(tmpdir(), "emdee-filename-"));
    await mkdir(docsDir, { recursive: true });
    await writeFile(path.join(docsDir, "PARENT.md"), PARENT_CONTENT, "utf8");
    ctx = { mode: "local", docsDir };
  });

  test.afterEach(async () => {
    await rm(docsDir, { recursive: true, force: true });
  });

  test("lint_doc emits filename_not_uppercase for lowercase basenames", async () => {
    await writeFile(
      path.join(docsDir, "lowercase-name.md"),
      `# Lowercase Name\n\n> A doc with a bad filename.\n`,
      "utf8",
    );
    const body = parseToolResult(await lintDoc(ctx, { path: "lowercase-name.md" }));
    const warnings = body.warnings as Array<{ code: string }>;
    expect(warnings.some((w) => w.code === "filename_not_uppercase")).toBe(true);
  });

  test("lint_doc does NOT emit the warning for uppercase basenames", async () => {
    const body = parseToolResult(await lintDoc(ctx, { path: "PARENT.md" }));
    const warnings = (body.warnings ?? []) as Array<{ code: string }>;
    expect(warnings.some((w) => w.code === "filename_not_uppercase")).toBe(false);
  });

  test("write_doc refuses lowercase path with a suggested fix", async () => {
    const body = parseToolResult(
      await writeDoc(ctx, {
        path: "lowercase-attempt.md",
        content: "# Test\n\n> body\n",
      }),
    );
    expect(body.error).toBe("filename_not_uppercase");
    expect(body.path).toBe("lowercase-attempt.md");
    expect(body.suggested).toBe("LOWERCASE-ATTEMPT.md");
    // File must NOT have been created.
    await expect(access(path.join(docsDir, "lowercase-attempt.md"))).rejects.toBeTruthy();
  });

  test("write_doc accepts uppercase path", async () => {
    const body = parseToolResult(
      await writeDoc(ctx, {
        path: "GOOD-DOC.md",
        content: "# Good Doc\n\n> body\n",
      }),
    );
    expect(body.ok).toBe(true);
    expect(body.path).toBe("GOOD-DOC.md");
    const content = await readFile(path.join(docsDir, "GOOD-DOC.md"), "utf8");
    expect(content).toContain("# Good Doc");
  });

  test("create_child auto-uppercases title-derived filenames", async () => {
    const body = parseToolResult(
      await createChild(ctx, {
        parent_path: "PARENT.md",
        title: "my new child node",
      }),
    );
    expect(body.ok).toBe(true);
    // Filename derived from title — should be uppercase.
    expect(body.child_path).toMatch(/MY-NEW-CHILD-NODE\.md$/);
  });

  test("create_child accepts em-dash in titles — the validator's hint promises this", async () => {
    // Regression for the 2026-07-20 bug: SLUG_SAFE rejected em-dash (—)
    // even though `title_not_slug_safe` error's own hint listed em-dash
    // as allowed. Downstream sanitizeFilename normalizes em-dash → hyphen
    // for the filesystem path, so the H1 keeps the em-dash while the
    // filename is Storage-key-safe.
    const body = parseToolResult(
      await createChild(ctx, {
        parent_path: "PARENT.md",
        title: "Product Map — DOUBLELEAD EMDEE WHATELZ",
      }),
    );
    expect(body.ok).toBe(true);
    expect(body.child_path).toMatch(/PRODUCT-MAP-DOUBLELEAD-EMDEE-WHATELZ\.md$/);
    const content = await readFile(path.join(docsDir, body.child_path as string), "utf8");
    // H1 preserves the em-dash even though the filename doesn't.
    expect(content).toContain("# Product Map — DOUBLELEAD EMDEE WHATELZ");
  });

  test("create_child refuses explicit lowercase child_path with a suggested fix", async () => {
    // Mirrors write_doc's refusal. Caller can re-run with the suggested
    // uppercase path, or omit child_path so the title-derived path is
    // generated (which goes through the uppercased sanitizeFilename).
    const body = parseToolResult(
      await createChild(ctx, {
        parent_path: "PARENT.md",
        title: "Forced Path Child",
        child_path: "lowercase-forced.md",
      }),
    );
    expect(body.error).toBe("filename_not_uppercase");
    expect(body.path).toBe("lowercase-forced.md");
    expect(body.suggested).toBe("LOWERCASE-FORCED.md");
  });
});
