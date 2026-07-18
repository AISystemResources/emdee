// SPRINT-081 HARD RULE 11 spec: list_summary_drift.
//
// Local-mode exercise — the tool returns every doc as candidate in local
// mode (no persistence), so this spec asserts the shape + slicing +
// format:"text" contract. The cloud-mode DB-driven drift logic is covered
// by unit-testable path splitting; wiring it in e2e requires cloud
// Supabase creds which local CI doesn't have. The local-mode contract is
// what the summariser workflow actually calls in the current sprint.

import { expect, test } from "@playwright/test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listSummaryDrift } from "@/src/lib/mcp/tools/list_summary_drift";
import type { ToolContext } from "@/src/lib/mcp/tools/types";

interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
}
function rawText(raw: unknown): string {
  const r = raw as ToolCallResult;
  expect(r.content?.[0]?.type).toBe("text");
  return r.content[0].text;
}

const ALPHA = `# ALPHA\n\n> First doc.\n\n## Notes\n\nBody.\n`;
const BETA = `# BETA\n\n> Second doc.\n\n## Notes\n\nBody.\n`;
const GAMMA = `# GAMMA\n\n> Third doc, longer.\n\n## Notes\n\nBody.\n`;

test.describe("list_summary_drift (SPRINT-081)", () => {
  let docsDir: string;
  let ctx: ToolContext;

  test.beforeEach(async () => {
    docsDir = await mkdtemp(path.join(tmpdir(), "emdee-drift-"));
    await writeFile(path.join(docsDir, "ALPHA.md"), ALPHA, "utf8");
    await writeFile(path.join(docsDir, "BETA.md"), BETA, "utf8");
    await writeFile(path.join(docsDir, "GAMMA.md"), GAMMA, "utf8");
    ctx = { mode: "local", docsDir };
  });

  test.afterEach(async () => {
    await rm(docsDir, { recursive: true, force: true });
  });

  test("local mode returns every doc as candidate (never_baselined)", async () => {
    const out = rawText(await listSummaryDrift(ctx, {}));
    const parsed = JSON.parse(out) as {
      returned: number;
      candidates: Array<{ path: string; current_summary: string; reason: string }>;
    };
    // SPRINT-093: 3 seeded docs + 5 virtual system nodes.
    expect(parsed.returned).toBe(8);
    const paths = parsed.candidates.map((c) => c.path).sort();
    expect(paths).toEqual([
      "ALPHA.md",
      "BETA.md",
      "EMDEE.md",
      "GAMMA.md",
      "GRAVEYARD.md",
      "IMAGES.md",
      "SHARED.md",
      "VAULT.md",
    ]);
    expect(parsed.candidates.every((c) => c.reason === "never_baselined")).toBe(true);
    const alpha = parsed.candidates.find((c) => c.path === "ALPHA.md")!;
    expect(alpha.current_summary).toBe("First doc.");
  });

  test("format:'text' returns newline-delimited paths", async () => {
    const out = rawText(await listSummaryDrift(ctx, { format: "text" }));
    const paths = out.split("\n").sort();
    expect(paths).toEqual([
      "ALPHA.md",
      "BETA.md",
      "EMDEE.md",
      "GAMMA.md",
      "GRAVEYARD.md",
      "IMAGES.md",
      "SHARED.md",
      "VAULT.md",
    ]);
  });

  test("limit + offset slice deterministically (sorted by path)", async () => {
    // SPRINT-093 sort order (alphabetical, system nodes interleaved):
    // ALPHA, BETA, EMDEE, GAMMA, GRAVEYARD, IMAGES, SHARED, VAULT.
    const first = JSON.parse(rawText(await listSummaryDrift(ctx, { limit: 2, offset: 0 })));
    const second = JSON.parse(rawText(await listSummaryDrift(ctx, { limit: 2, offset: 2 })));
    expect(first.candidates.map((c: { path: string }) => c.path)).toEqual(["ALPHA.md", "BETA.md"]);
    expect(second.candidates.map((c: { path: string }) => c.path)).toEqual(["EMDEE.md", "GAMMA.md"]);
  });

  test("prefix filter narrows the working set", async () => {
    const out = rawText(await listSummaryDrift(ctx, { prefix: "ALPHA", format: "text" }));
    expect(out).toBe("ALPHA.md");
  });
});
