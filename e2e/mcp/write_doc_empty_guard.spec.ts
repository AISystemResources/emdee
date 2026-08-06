// SPRINT-186: HARD RULE 11 spec for the empty-write guard on write_doc.
//
// Background: two hub docs (03-DOUBLELEAD, 02-WHATELZ_AI) were found
// empty in the same week without any caller admitting to the write —
// some path was silently zeroing content. This spec pins the boundary
// guard that catches such writes at the moment they hit `write_doc`.

import { expect, test } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeDoc } from "@/src/lib/mcp/tools/write_doc";
import type { ToolContext } from "@/src/lib/mcp/tools/types";
import { localToolContext } from "@/src/lib/mcp/tools/context";

interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
}

function parse(raw: unknown): Record<string, unknown> {
  const r = raw as ToolCallResult;
  expect(r.content?.[0]?.type).toBe("text");
  return JSON.parse(r.content[0].text) as Record<string, unknown>;
}

const NON_EMPTY_CONTENT = `# EXISTING

> A doc with real content that we don't want silently wiped.

## Notes

Important stuff here.
`;

test.describe("write_doc empty-content guard (SPRINT-186)", () => {
  let docsDir: string;
  let ctx: ToolContext;

  test.beforeEach(async () => {
    docsDir = await mkdtemp(path.join(tmpdir(), "emdee-empty-guard-"));
    await mkdir(docsDir, { recursive: true });
    await writeFile(path.join(docsDir, "EXISTING.md"), NON_EMPTY_CONTENT, "utf8");
    ctx = localToolContext(docsDir);
  });

  test.afterEach(async () => {
    await rm(docsDir, { recursive: true, force: true });
  });

  test("refuses an empty-string write over an existing non-empty doc", async () => {
    const r = parse(await writeDoc(ctx, { path: "EXISTING.md", content: "" }));
    expect(r.error).toBe("empty_write_would_delete_content");
    expect(r.existing_length).toBe(NON_EMPTY_CONTENT.length);

    // File on disk must be unchanged.
    const onDisk = await readFile(path.join(docsDir, "EXISTING.md"), "utf8");
    expect(onDisk).toBe(NON_EMPTY_CONTENT);
  });

  test("refuses a whitespace-only write over an existing non-empty doc", async () => {
    // trim().length === 0 covers "  \n\t\n" too — the guard triggers on
    // effectively-empty content, not just literal "".
    const r = parse(await writeDoc(ctx, { path: "EXISTING.md", content: "  \n\t\n  " }));
    expect(r.error).toBe("empty_write_would_delete_content");
  });

  test("allow_empty=true overrides the guard", async () => {
    // Escape hatch for the rare legit case (resetting a scratch doc).
    const r = parse(await writeDoc(ctx, {
      path: "EXISTING.md",
      content: "",
      allow_empty: true,
    }));
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();

    const onDisk = await readFile(path.join(docsDir, "EXISTING.md"), "utf8");
    expect(onDisk).toBe("");
  });

  test("empty write to a NEW (non-existent) doc is allowed — nothing to wipe", async () => {
    // Guard only fires when there's existing non-empty content. Creating
    // a fresh empty doc is legit (rare but not a bug).
    const r = parse(await writeDoc(ctx, {
      path: "BRAND_NEW.md",
      content: "",
    }));
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
  });

  test("non-empty write works exactly as before", async () => {
    // Sanity: the guard doesn't touch the happy path.
    const newContent = "# EXISTING\n\n> Updated content.\n\n## Notes\n\nNew stuff.\n";
    const r = parse(await writeDoc(ctx, { path: "EXISTING.md", content: newContent }));
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();

    const onDisk = await readFile(path.join(docsDir, "EXISTING.md"), "utf8");
    expect(onDisk).toBe(newContent);
  });
});
