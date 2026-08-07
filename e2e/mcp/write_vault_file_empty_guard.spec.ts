// SPRINT-187: belt-and-braces guard at the writeVaultFile helper.
//
// SPRINT-186 guarded write_doc. SPRINT-187 also guards /api/doc PUT
// (the editor path). This spec covers the third layer: the shared
// helper every MCP tool uses. If a future tool bypasses write_doc but
// still uses writeVaultFile, this guard catches it.

import { expect, test } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeVaultFile, EmptyWriteRefusedError } from "@/src/lib/mcp/tools/vault";
import { localToolContext } from "@/src/lib/mcp/tools/context";

const NON_EMPTY = `# EXISTING\n\n> Real content.\n`;

test.describe("writeVaultFile empty guard (SPRINT-187)", () => {
  let docsDir: string;

  test.beforeEach(async () => {
    docsDir = await mkdtemp(path.join(tmpdir(), "emdee-wvf-guard-"));
    await mkdir(docsDir, { recursive: true });
    await writeFile(path.join(docsDir, "EXISTING.md"), NON_EMPTY, "utf8");
  });

  test.afterEach(async () => {
    await rm(docsDir, { recursive: true, force: true });
  });

  test("throws EmptyWriteRefusedError on empty content over non-empty doc", async () => {
    const ctx = localToolContext(docsDir);
    let caught: unknown = null;
    try {
      await writeVaultFile(ctx, "EXISTING.md", "");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EmptyWriteRefusedError);
    expect((caught as EmptyWriteRefusedError).code).toBe("empty_write_would_delete_content");
    expect((caught as EmptyWriteRefusedError).existingLength).toBe(NON_EMPTY.length);

    // File preserved.
    const onDisk = await readFile(path.join(docsDir, "EXISTING.md"), "utf8");
    expect(onDisk).toBe(NON_EMPTY);
  });

  test("allowEmpty: true overrides the guard", async () => {
    const ctx = localToolContext(docsDir);
    await writeVaultFile(ctx, "EXISTING.md", "", { allowEmpty: true });
    const onDisk = await readFile(path.join(docsDir, "EXISTING.md"), "utf8");
    expect(onDisk).toBe("");
  });

  test("empty write to a new (non-existent) doc is allowed", async () => {
    const ctx = localToolContext(docsDir);
    await writeVaultFile(ctx, "BRAND_NEW.md", "");
    const onDisk = await readFile(path.join(docsDir, "BRAND_NEW.md"), "utf8");
    expect(onDisk).toBe("");
  });

  test("non-empty writes work exactly as before", async () => {
    const ctx = localToolContext(docsDir);
    const newContent = "# EXISTING\n\n> Updated.\n";
    await writeVaultFile(ctx, "EXISTING.md", newContent);
    const onDisk = await readFile(path.join(docsDir, "EXISTING.md"), "utf8");
    expect(onDisk).toBe(newContent);
  });
});
