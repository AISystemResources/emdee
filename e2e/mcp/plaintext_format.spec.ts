// SPRINT-080 HARD RULE 11 spec: `format: "text"` opt-in on read tools.
//
// Exercises get_doc, get_summary, list_docs directly against a local-mode
// ToolContext + temp filesystem (SPRINT-054 pattern). Verifies (a) the
// plaintext response shape is bare markdown/text with no JSON envelope,
// and (b) the default (json) response is byte-identical to pre-sprint —
// no regressions for existing callers.

import { expect, test } from "@playwright/test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getDoc } from "@/src/lib/mcp/tools/get_doc";
import { getSummary } from "@/src/lib/mcp/tools/get_summary";
import { listDocs } from "@/src/lib/mcp/tools/list_docs";
import type { ToolContext } from "@/src/lib/mcp/tools/types";

interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
}

function rawText(raw: unknown): string {
  const result = raw as ToolCallResult;
  expect(result.content?.[0]?.type).toBe("text");
  return result.content[0].text;
}

const ROOT_CONTENT = `# ROOT

> Test-vault entry point.

## Parent of

* [[CHILD]]
`;

const CHILD_CONTENT = `# CHILD

> A leaf doc for shape assertions.

## Child of

* [[ROOT]]

## Notes

Some prose.
`;

test.describe("plaintext format opt-in (SPRINT-080)", () => {
  let docsDir: string;
  let ctx: ToolContext;

  test.beforeEach(async () => {
    docsDir = await mkdtemp(path.join(tmpdir(), "emdee-plaintext-"));
    await writeFile(path.join(docsDir, "ROOT.md"), ROOT_CONTENT, "utf8");
    await writeFile(path.join(docsDir, "CHILD.md"), CHILD_CONTENT, "utf8");
    ctx = { mode: "local", docsDir };
  });

  test.afterEach(async () => {
    await rm(docsDir, { recursive: true, force: true });
  });

  test("get_doc format:'text' full:true returns raw file content", async () => {
    const out = rawText(await getDoc(ctx, { path: "CHILD.md", full: true, format: "text" }));
    expect(out).toBe(CHILD_CONTENT);
  });

  test("get_doc format:'text' (full:false) returns H1 + summary + section headings", async () => {
    const out = rawText(await getDoc(ctx, { path: "CHILD.md", format: "text" }));
    expect(out).toBe(
      `# CHILD\n\n> A leaf doc for shape assertions.\n\n## Child of\n## Notes`,
    );
  });

  test("get_doc default (no format) returns JSON envelope unchanged", async () => {
    const out = rawText(await getDoc(ctx, { path: "CHILD.md" }));
    const parsed = JSON.parse(out);
    expect(parsed.path).toBe("CHILD.md");
    expect(parsed.title).toBe("CHILD");
    expect(parsed.summary).toBe("A leaf doc for shape assertions.");
    expect(typeof parsed.doc_content_hash).toBe("string");
    expect(Array.isArray(parsed.sections)).toBe(true);
  });

  test("get_summary format:'text' returns the bare blockquote line", async () => {
    const out = rawText(await getSummary(ctx, { path: "CHILD.md", format: "text" }));
    expect(out).toBe("A leaf doc for shape assertions.");
  });

  test("get_summary default (no format) returns JSON envelope unchanged", async () => {
    const out = rawText(await getSummary(ctx, { path: "CHILD.md" }));
    const parsed = JSON.parse(out);
    expect(parsed).toEqual({
      path: "CHILD.md",
      title: "CHILD",
      summary: "A leaf doc for shape assertions.",
    });
  });

  test("list_docs format:'text' returns newline-delimited paths", async () => {
    const out = rawText(await listDocs(ctx, { format: "text" }));
    const paths = out.split("\n").sort();
    expect(paths).toEqual(["CHILD.md", "ROOT.md"]);
  });

  test("list_docs default (no format) returns JSON array of {path,title,summary}", async () => {
    const out = rawText(await listDocs(ctx, {}));
    const parsed = JSON.parse(out) as Array<{ path: string; title: string; summary: string }>;
    expect(parsed.length).toBe(2);
    const child = parsed.find((d) => d.path === "CHILD.md")!;
    expect(child.title).toBe("CHILD");
    expect(child.summary).toBe("A leaf doc for shape assertions.");
  });

  test("plaintext output is materially cheaper than JSON envelope", async () => {
    const textOut = rawText(await getDoc(ctx, { path: "CHILD.md", full: true, format: "text" }));
    const jsonOut = rawText(await getDoc(ctx, { path: "CHILD.md", full: true }));
    // Chars/4 ≈ tokens. Assert the plaintext response is <50% of the JSON envelope.
    expect(textOut.length).toBeLessThan(jsonOut.length * 0.5);
  });
});
