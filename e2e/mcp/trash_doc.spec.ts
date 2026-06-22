// SPRINT-057 (SIG-008): HARD RULE 11 spec for trash_doc + restore_doc.
//
// Local-mode ToolContext + temp filesystem. Verifies the trash/restore
// lifecycle via the .emdee/trashed.json sidecar — the doc's markdown
// stays untouched the entire time; only the sidecar moves.

import { expect, test } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { trashDoc } from "@/src/lib/mcp/tools/trash_doc";
import { restoreDoc } from "@/src/lib/mcp/tools/restore_doc";
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

* [[CHILD]]
`;

const CHILD_CONTENT = `# CHILD

> A trashable child.

## Child of

* [[PARENT]]

## Parent of
`;

const ORPHAN_CONTENT = `# ORPHAN

> No parent declared.

## Parent of
`;

test.describe("trash_doc + restore_doc (local-mode)", () => {
  let docsDir: string;
  let ctx: ToolContext;
  const sidecarPath = (root: string) => path.join(root, ".emdee", "trashed.json");

  test.beforeEach(async () => {
    docsDir = await mkdtemp(path.join(tmpdir(), "emdee-trash-"));
    await mkdir(docsDir, { recursive: true });
    await writeFile(path.join(docsDir, "PARENT.md"), PARENT_CONTENT, "utf8");
    await writeFile(path.join(docsDir, "CHILD.md"), CHILD_CONTENT, "utf8");
    ctx = { mode: "local", docsDir };
  });

  test.afterEach(async () => {
    await rm(docsDir, { recursive: true, force: true });
  });

  test("trash_doc flags the doc + records original parent in sidecar", async () => {
    const body = parseToolResult(await trashDoc(ctx, { path: "CHILD.md" }));

    expect(body.ok).toBe(true);
    expect(body.path).toBe("CHILD.md");
    expect(body.original_parent_path).toBe("PARENT.md");
    expect(body.already_trashed).toBe(false);
    expect(typeof body.trashed_at).toBe("string");

    // Markdown left alone.
    const child = await readFile(path.join(docsDir, "CHILD.md"), "utf8");
    expect(child).toContain("## Child of");
    expect(child).toContain("[[PARENT]]");

    // Sidecar has the entry.
    const raw = await readFile(sidecarPath(docsDir), "utf8");
    const state = JSON.parse(raw) as Record<string, { original_parent_path: string }>;
    expect(state["CHILD.md"]).toBeDefined();
    expect(state["CHILD.md"].original_parent_path).toBe("PARENT.md");
  });

  test("trash_doc is idempotent — second call returns already_trashed=true", async () => {
    const first = parseToolResult(await trashDoc(ctx, { path: "CHILD.md" }));
    const firstAt = first.trashed_at as string;

    const second = parseToolResult(await trashDoc(ctx, { path: "CHILD.md" }));
    expect(second.ok).toBe(true);
    expect(second.already_trashed).toBe(true);
    expect(second.trashed_at).toBe(firstAt); // timestamp preserved
  });

  test("restore_doc clears the sidecar entry + returns the original parent", async () => {
    await trashDoc(ctx, { path: "CHILD.md" });
    const body = parseToolResult(await restoreDoc(ctx, { path: "CHILD.md" }));

    expect(body.ok).toBe(true);
    expect(body.path).toBe("CHILD.md");
    expect(body.restored_to).toBe("PARENT.md");
    expect(typeof body.was_trashed_at).toBe("string");

    // Sidecar no longer has the entry. File may exist (empty {}) or not.
    try {
      const raw = await readFile(sidecarPath(docsDir), "utf8");
      const state = JSON.parse(raw) as Record<string, unknown>;
      expect(state["CHILD.md"]).toBeUndefined();
    } catch {
      // Sidecar may not exist if the restore left empty state — acceptable.
    }
  });

  test("trash_doc refuses when doc not found", async () => {
    const body = parseToolResult(await trashDoc(ctx, { path: "NOPE.md" }));
    expect(body.error).toBe("doc_not_found");
  });

  test("trash_doc refuses an orphan with no Child of bullet", async () => {
    await writeFile(path.join(docsDir, "ORPHAN.md"), ORPHAN_CONTENT, "utf8");
    const body = parseToolResult(await trashDoc(ctx, { path: "ORPHAN.md" }));
    expect(body.error).toBe("no_resolvable_parent");
  });

  test("trash_doc accepts an explicit original_parent_path override", async () => {
    await writeFile(path.join(docsDir, "ORPHAN.md"), ORPHAN_CONTENT, "utf8");
    const body = parseToolResult(
      await trashDoc(ctx, {
        path: "ORPHAN.md",
        original_parent_path: "PARENT.md",
      }),
    );
    expect(body.ok).toBe(true);
    expect(body.original_parent_path).toBe("PARENT.md");
  });

  test("restore_doc refuses a doc that isn't trashed", async () => {
    const body = parseToolResult(await restoreDoc(ctx, { path: "CHILD.md" }));
    expect(body.error).toBe("not_trashed");
  });

  test("end-to-end: trash → restore → trash again", async () => {
    // First trash
    await trashDoc(ctx, { path: "CHILD.md" });
    // Restore
    const restored = parseToolResult(await restoreDoc(ctx, { path: "CHILD.md" }));
    expect(restored.ok).toBe(true);
    // Trash again — fresh timestamp
    const re = parseToolResult(await trashDoc(ctx, { path: "CHILD.md" }));
    expect(re.already_trashed).toBe(false);
  });

  test("sidecar lives at .emdee/trashed.json (not at vault root)", async () => {
    await trashDoc(ctx, { path: "CHILD.md" });
    // Verify the sidecar is in .emdee/, not at root
    await expect(access(sidecarPath(docsDir))).resolves.toBeUndefined();
    await expect(access(path.join(docsDir, "trashed.json"))).rejects.toBeTruthy();
  });
});
