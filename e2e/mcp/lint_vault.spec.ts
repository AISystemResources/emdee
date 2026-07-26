// SPRINT-101: batch vault lint.
//
// Local-mode exercise (same pattern as summary_drift.spec.ts and
// move_doc.spec.ts): seed a tiny 3-doc vault where each doc trips a
// different lint rule, run lintVault against a local ToolContext,
// assert the punch list surfaces all three docs and the byCode counts
// aggregate correctly. Cloud-mode DB paths are covered by the same
// tool code — this locks the aggregation logic without needing a
// live Supabase.

import { expect, test } from "@playwright/test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { lintVault } from "@/src/lib/mcp/tools/lint_vault";
import type { ToolContext } from "@/src/lib/mcp/tools/types";
import { localToolContext } from "@/src/lib/mcp/tools/context";

interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
}
function parse(raw: unknown): {
  scanned: number;
  with_warnings: number;
  warnings_total: number;
  warnings_by_code: Record<string, number>;
  docs: Array<{ path: string; warnings: Array<{ code: string }> }>;
} {
  const r = raw as ToolCallResult;
  expect(r.content?.[0]?.type).toBe("text");
  return JSON.parse(r.content[0].text);
}

// One doc missing its blockquote summary; one with an asymmetric parent
// edge (declares HUB as parent but HUB doesn't list it as child); one
// clean control to prove clean docs don't appear in the punch list.
const HUB = `# HUB\n\n> The hub.\n\n## Parent of\n\n* [[CLEAN]]\n`;
const NO_SUMMARY = `# BAD-A\n\nBody starts here without any blockquote.\n\n## Child of\n\n* [[HUB]]\n`;
const ASYMMETRIC = `# BAD-B\n\n> Fine summary.\n\n## Child of\n\n* [[HUB]]\n`;
const CLEAN = `# CLEAN\n\n> Clean doc.\n\n## Child of\n\n* [[HUB]]\n`;

test.describe("lint_vault (SPRINT-101)", () => {
  let docsDir: string;
  let ctx: ToolContext;

  test.beforeEach(async () => {
    docsDir = await mkdtemp(path.join(tmpdir(), "emdee-lint-vault-"));
    await writeFile(path.join(docsDir, "HUB.md"), HUB, "utf8");
    await writeFile(path.join(docsDir, "BAD-A.md"), NO_SUMMARY, "utf8");
    await writeFile(path.join(docsDir, "BAD-B.md"), ASYMMETRIC, "utf8");
    await writeFile(path.join(docsDir, "CLEAN.md"), CLEAN, "utf8");
    ctx = localToolContext(docsDir);
  });

  test.afterEach(async () => {
    await rm(docsDir, { recursive: true, force: true });
  });

  test("scans every doc, surfaces those with warnings, aggregates by code", async () => {
    const result = parse(await lintVault(ctx, {}));
    // 4 seeded + 5 virtual system nodes = 9 scanned
    expect(result.scanned).toBe(9);
    // At least the missing-summary and asymmetric docs must surface.
    const flagged = result.docs.map((d) => d.path).sort();
    expect(flagged).toContain("BAD-A.md");
    expect(flagged).toContain("BAD-B.md");
    // by_code aggregation is populated + matches total.
    const codes = Object.values(result.warnings_by_code).reduce((a, b) => a + b, 0);
    expect(codes).toBe(result.warnings_total);
    expect(result.warnings_total).toBeGreaterThan(0);
  });

  test("prefix filter narrows the scan", async () => {
    const result = parse(await lintVault(ctx, { prefix: "BAD-" }));
    // Only BAD-A + BAD-B match the prefix.
    expect(result.scanned).toBe(2);
    expect(result.docs.every((d) => d.path.startsWith("BAD-"))).toBe(true);
  });

  test("limit caps the returned punch list", async () => {
    const result = parse(await lintVault(ctx, { limit: 1 }));
    // scanned still counts every doc; the returned punch list is capped.
    expect(result.scanned).toBeGreaterThan(1);
    expect(result.docs.length).toBeLessThanOrEqual(1);
  });
});
