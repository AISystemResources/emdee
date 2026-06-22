// SPRINT-054 (SIG-003): HARD RULE 11 spec for move_doc.
//
// Exercises the tool function directly against a local-mode ToolContext +
// temp filesystem. This is the runtime-correctness gate that pure typecheck
// can't catch — a syntactically-valid tool that mangles markdown sections
// would fail here. We don't hit `POST /api/mcp` because the HTTP endpoint
// requires OAuth Bearer auth that CI has no easy way to provision; the
// local-mode path runs the same tool code with the same vault helpers, so
// the safety promise is preserved.

import { expect, test } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { moveDoc } from "@/src/lib/mcp/tools/move_doc";
import type { ToolContext } from "@/src/lib/mcp/tools/types";

interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
}

function parseToolResult(raw: unknown): Record<string, unknown> {
  const result = raw as ToolCallResult;
  expect(result.content?.[0]?.type).toBe("text");
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

const OLD_PARENT_CONTENT = `# OLD-PARENT

> Source parent.

## Child of

* [[ROOT]]

## Parent of

* [[CHILD]]
* [[OTHER-CHILD]]
`;

const NEW_PARENT_CONTENT = `# NEW-PARENT

> Target parent.

## Child of

* [[ROOT]]

## Parent of

* [[EXISTING-CHILD]]
`;

const CHILD_CONTENT = `# CHILD

> A reparentable child.

## Child of

* [[OLD-PARENT]]

## Parent of
`;

test.describe("move_doc (local-mode tool exercise)", () => {
  let docsDir: string;
  let ctx: ToolContext;

  test.beforeEach(async () => {
    docsDir = await mkdtemp(path.join(tmpdir(), "emdee-move-doc-"));
    await mkdir(docsDir, { recursive: true });
    await writeFile(path.join(docsDir, "OLD-PARENT.md"), OLD_PARENT_CONTENT, "utf8");
    await writeFile(path.join(docsDir, "NEW-PARENT.md"), NEW_PARENT_CONTENT, "utf8");
    await writeFile(path.join(docsDir, "CHILD.md"), CHILD_CONTENT, "utf8");
    ctx = { mode: "local", docsDir };
  });

  test.afterEach(async () => {
    await rm(docsDir, { recursive: true, force: true });
  });

  test("reparents a child atomically — three sides updated", async () => {
    const raw = await moveDoc(ctx, {
      path: "CHILD.md",
      new_parent_path: "NEW-PARENT.md",
    });
    const body = parseToolResult(raw);

    expect(body.ok).toBe(true);
    expect(body.child_updated).toBe(true);
    expect(body.old_parent_updated).toBe(true);
    expect(body.new_parent_updated).toBe(true);
    expect(body.old_parent_path).toBe("OLD-PARENT.md");

    // Child now declares NEW-PARENT only.
    const child = await readFile(path.join(docsDir, "CHILD.md"), "utf8");
    expect(child).toMatch(/## Child of\s+\*\s+\[\[NEW-PARENT\]\]/);
    expect(child).not.toMatch(/\[\[OLD-PARENT\]\]/);

    // Old parent no longer lists CHILD.
    const oldParent = await readFile(path.join(docsDir, "OLD-PARENT.md"), "utf8");
    expect(oldParent).not.toMatch(/\*\s+\[\[CHILD\]\]/);
    expect(oldParent).toMatch(/\*\s+\[\[OTHER-CHILD\]\]/); // sibling untouched

    // New parent now lists CHILD.
    const newParent = await readFile(path.join(docsDir, "NEW-PARENT.md"), "utf8");
    expect(newParent).toMatch(/\*\s+\[\[CHILD\]\]/);
    expect(newParent).toMatch(/\*\s+\[\[EXISTING-CHILD\]\]/); // existing bullet preserved
  });

  test("refuses when child has no Child of section", async () => {
    await writeFile(
      path.join(docsDir, "ORPHAN.md"),
      `# ORPHAN\n\n> No parent.\n`,
      "utf8",
    );
    const body = parseToolResult(
      await moveDoc(ctx, { path: "ORPHAN.md", new_parent_path: "NEW-PARENT.md" }),
    );
    expect(body.error).toBe("no_existing_parent");
  });

  test("refuses when child not found", async () => {
    const body = parseToolResult(
      await moveDoc(ctx, { path: "NOPE.md", new_parent_path: "NEW-PARENT.md" }),
    );
    expect(body.error).toBe("child_not_found");
  });

  test("refuses when new parent not found", async () => {
    const body = parseToolResult(
      await moveDoc(ctx, { path: "CHILD.md", new_parent_path: "GHOST.md" }),
    );
    expect(body.error).toBe("new_parent_not_found");
  });

  test("refuses move-to-self", async () => {
    const body = parseToolResult(
      await moveDoc(ctx, { path: "CHILD.md", new_parent_path: "CHILD.md" }),
    );
    expect(body.error).toBe("cannot_move_to_self");
  });

  test("requires old_parent_path when child has multiple parents", async () => {
    const multiParent = CHILD_CONTENT.replace(
      "* [[OLD-PARENT]]",
      "* [[OLD-PARENT]]\n* [[NEW-PARENT]]",
    );
    await writeFile(path.join(docsDir, "CHILD.md"), multiParent, "utf8");
    const body = parseToolResult(
      await moveDoc(ctx, { path: "CHILD.md", new_parent_path: "NEW-PARENT.md" }),
    );
    expect(body.error).toBe("ambiguous_parent");
    expect(Array.isArray(body.declared_parents)).toBe(true);
  });

  test("idempotent — re-running on an already-moved doc returns no-op", async () => {
    await moveDoc(ctx, { path: "CHILD.md", new_parent_path: "NEW-PARENT.md" });
    const body = parseToolResult(
      await moveDoc(ctx, { path: "CHILD.md", new_parent_path: "NEW-PARENT.md" }),
    );
    expect(body.ok).toBe(true);
    expect(body.child_updated).toBe(false);
    expect(body.old_parent_updated).toBe(false);
    expect(body.new_parent_updated).toBe(false);
  });
});
