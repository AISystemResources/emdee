// SPRINT-116: HARD RULE 11 spec for rename_title.
//
// Exercises the tool function directly against a local-mode ToolContext +
// temp filesystem. Verifies:
// 1. Every `[[old_title]]` occurrence across the vault is rewritten
// 2. Piped-alias form `[[old_title|display]]` is rewritten, alias preserved
// 3. Case-insensitive matching (matches [[EMDEE_OS — LOGS]] and [[emdee_os — logs]])
// 4. Docs without matches are not touched (no unnecessary writes)
// 5. old_title == new_title is refused
// 6. Missing args are validated

import { expect, test } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { renameTitle } from "@/src/lib/mcp/tools/rename_title";
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

async function setup() {
  const docsDir = await mkdtemp(path.join(tmpdir(), "emdee-rename-title-"));
  return docsDir;
}

async function teardown(docsDir: string) {
  await rm(docsDir, { recursive: true, force: true });
}

test.describe("rename_title", () => {
  test("rewrites simple wiki-link across multiple docs", async () => {
    const docsDir = await setup();
    try {
      await writeFile(path.join(docsDir, "HUB.md"),
        `# HUB\n\n> A hub.\n\n## Parent of\n\n* [[CHILD-ONE]]\n* [[CHILD-TWO]]\n`);
      await writeFile(path.join(docsDir, "CHILD-ONE.md"),
        `# CHILD-ONE\n\n> First child.\n\n## Child of\n\n* [[HUB]]\n`);
      await writeFile(path.join(docsDir, "CHILD-TWO.md"),
        `# CHILD-TWO\n\n> Second child.\n\n## Child of\n\n* [[HUB]]\n`);
      await writeFile(path.join(docsDir, "UNRELATED.md"),
        `# UNRELATED\n\n> Nothing to see.\n`);

      const ctx: ToolContext = localToolContext(docsDir);
      const result = parse(await renameTitle(ctx, { old_title: "HUB", new_title: "NEW-HUB" }));

      expect(result.ok).toBe(true);
      expect(result.docs_rewritten).toBe(2);

      const c1 = await readFile(path.join(docsDir, "CHILD-ONE.md"), "utf8");
      const c2 = await readFile(path.join(docsDir, "CHILD-TWO.md"), "utf8");
      const unr = await readFile(path.join(docsDir, "UNRELATED.md"), "utf8");
      expect(c1).toContain("[[NEW-HUB]]");
      expect(c1).not.toContain("[[HUB]]");
      expect(c2).toContain("[[NEW-HUB]]");
      expect(unr).not.toContain("NEW-HUB");
    } finally { await teardown(docsDir); }
  });

  test("preserves alias in piped wiki-links", async () => {
    const docsDir = await setup();
    try {
      await writeFile(path.join(docsDir, "REF.md"),
        `# REF\n\n> See [[OLD-TITLE|the docs]] for details.\n`);
      const ctx: ToolContext = localToolContext(docsDir);
      const result = parse(await renameTitle(ctx, { old_title: "OLD-TITLE", new_title: "NEW-TITLE" }));
      expect(result.docs_rewritten).toBe(1);
      const ref = await readFile(path.join(docsDir, "REF.md"), "utf8");
      expect(ref).toContain("[[NEW-TITLE|the docs]]");
    } finally { await teardown(docsDir); }
  });

  test("case-insensitive match", async () => {
    const docsDir = await setup();
    try {
      await writeFile(path.join(docsDir, "A.md"), `# A\n\n> [[emdee_os — LOGS]]\n`);
      await writeFile(path.join(docsDir, "B.md"), `# B\n\n> [[EMDEE_OS — Logs]]\n`);
      const ctx: ToolContext = localToolContext(docsDir);
      const result = parse(await renameTitle(ctx, {
        old_title: "EMDEE_OS — LOGS",
        new_title: "EMDEE_OS — PRODUCTION — LOGS",
      }));
      expect(result.docs_rewritten).toBe(2);
    } finally { await teardown(docsDir); }
  });

  test("refuses when old_title == new_title", async () => {
    const docsDir = await setup();
    try {
      await writeFile(path.join(docsDir, "X.md"), `# X\n\n> body\n`);
      const ctx: ToolContext = localToolContext(docsDir);
      const result = parse(await renameTitle(ctx, { old_title: "SAME", new_title: "SAME" }));
      expect(result.error).toBe("titles_identical");
    } finally { await teardown(docsDir); }
  });

  test("refuses when old_title missing", async () => {
    const docsDir = await setup();
    try {
      const ctx: ToolContext = localToolContext(docsDir);
      const result = parse(await renameTitle(ctx, { new_title: "Only" }));
      expect(result.error).toBe("missing_required");
    } finally { await teardown(docsDir); }
  });

  test("bulk-safe: 20 docs rewritten in one call", async () => {
    const docsDir = await setup();
    try {
      for (let i = 0; i < 20; i++) {
        await writeFile(path.join(docsDir, `DOC-${i}.md`),
          `# DOC-${i}\n\n> Content mentioning [[OLD]] and [[OLD|alias]].\n`);
      }
      const ctx: ToolContext = localToolContext(docsDir);
      const result = parse(await renameTitle(ctx, { old_title: "OLD", new_title: "NEW" }));
      expect(result.ok).toBe(true);
      expect(result.docs_rewritten).toBe(20);
      // Spot-check a few
      for (const i of [0, 5, 10, 19]) {
        const c = await readFile(path.join(docsDir, `DOC-${i}.md`), "utf8");
        expect(c).toContain("[[NEW]]");
        expect(c).toContain("[[NEW|alias]]");
        expect(c).not.toContain("[[OLD]]");
      }
    } finally { await teardown(docsDir); }
  });
});
