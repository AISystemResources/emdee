// SPRINT-102 Tier 1: lint_vault_autofix — mechanical bullet removal for
// sibling_assoc_redundant + associate_duplicates_hierarchy.
//
// Two docs under a shared parent, each declaring the other in Associated
// with, trip sibling_assoc_redundant. A third doc has both a parent AND
// an assoc pointing at the same target (hierarchy overlap), tripping
// associate_duplicates_hierarchy. Autofix should strip the bullets from
// all three, leaving the hierarchy intact.

import { expect, test } from "@playwright/test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { lintVaultAutofix } from "@/src/lib/mcp/tools/lint_vault_autofix";
import type { ToolContext } from "@/src/lib/mcp/tools/types";

interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
}
function parse(raw: unknown): {
  tier: number;
  dry_run: boolean;
  scanned: number;
  planned_fixes: Array<{ path: string; bullets: Array<{ title: string; code: string }> }>;
  docs_to_modify: number;
  bullets_to_remove: number;
  applied: number;
  failed?: Array<{ path: string; error: string }>;
} {
  const r = raw as ToolCallResult;
  expect(r.content?.[0]?.type).toBe("text");
  return JSON.parse(r.content[0].text);
}

const HUB = `# HUB\n\n> The hub.\n\n## Parent of\n\n* [[A]]\n* [[B]]\n`;
// A and B are siblings under HUB. Each also lists the other under
// Associated with — triggers sibling_assoc_redundant on both docs.
const A = `# A\n\n> Sibling A.\n\n## Child of\n\n* [[HUB]]\n\n## Associated with\n\n* [[B]] — an unnecessary assoc\n\n## Notes\n\nBody.\n`;
const B = `# B\n\n> Sibling B.\n\n## Child of\n\n* [[HUB]]\n\n## Associated with\n\n* [[A]] — mirror of A's bad assoc\n`;
// C has HUB as parent AND as an associate — triggers
// associate_duplicates_hierarchy.
const C = `# C\n\n> Third child.\n\n## Child of\n\n* [[HUB]]\n\n## Associated with\n\n* [[HUB]] — the hierarchy edge already covers this\n`;

test.describe("lint_vault_autofix Tier 1 (SPRINT-102)", () => {
  let docsDir: string;
  let ctx: ToolContext;

  test.beforeEach(async () => {
    docsDir = await mkdtemp(path.join(tmpdir(), "emdee-autofix-"));
    await writeFile(path.join(docsDir, "HUB.md"), HUB, "utf8");
    await writeFile(path.join(docsDir, "A.md"), A, "utf8");
    await writeFile(path.join(docsDir, "B.md"), B, "utf8");
    await writeFile(path.join(docsDir, "C.md"), C, "utf8");
    ctx = { mode: "local", docsDir };
  });

  test.afterEach(async () => {
    await rm(docsDir, { recursive: true, force: true });
  });

  test("dry-run: plans the fixes, writes nothing", async () => {
    const result = parse(await lintVaultAutofix(ctx, {}));
    expect(result.dry_run).toBe(true);
    expect(result.applied).toBe(0);
    expect(result.docs_to_modify).toBeGreaterThanOrEqual(3);
    // A, B, C should all appear in the plan
    const plannedPaths = result.planned_fixes.map((f) => f.path).sort();
    expect(plannedPaths).toContain("A.md");
    expect(plannedPaths).toContain("B.md");
    expect(plannedPaths).toContain("C.md");
    // Files on disk unchanged
    expect(await readFile(path.join(docsDir, "A.md"), "utf8")).toBe(A);
  });

  test("apply (dry_run=false): strips the bullets, hierarchy intact", async () => {
    const result = parse(await lintVaultAutofix(ctx, { dry_run: false }));
    expect(result.dry_run).toBe(false);
    expect(result.applied).toBeGreaterThanOrEqual(3);
    // After autofix, none of A/B/C should have the offending assoc bullet.
    const aAfter = await readFile(path.join(docsDir, "A.md"), "utf8");
    expect(aAfter).not.toContain("[[B]]");
    expect(aAfter).toContain("[[HUB]]"); // hierarchy intact
    const bAfter = await readFile(path.join(docsDir, "B.md"), "utf8");
    expect(bAfter).not.toContain("[[A]]");
    expect(bAfter).toContain("[[HUB]]");
    const cAfter = await readFile(path.join(docsDir, "C.md"), "utf8");
    // C had [[HUB]] TWICE — once in Child of (must stay), once in Associated with (must go).
    // After strip, only one [[HUB]] reference should remain (in Child of).
    expect(cAfter.match(/\[\[HUB\]\]/g)?.length).toBe(1);
  });

  test("re-running after apply is a no-op — idempotent", async () => {
    await lintVaultAutofix(ctx, { dry_run: false });
    const second = parse(await lintVaultAutofix(ctx, {}));
    // Second dry-run should find nothing to fix.
    expect(second.docs_to_modify).toBe(0);
    expect(second.bullets_to_remove).toBe(0);
  });
});
