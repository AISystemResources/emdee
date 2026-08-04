// SPRINT-181: HARD RULE 11 spec for the syncDocEdges reciprocal-edge fix.
//
// Before this sprint, per-doc reconcile of a CHILD that declared `Child of
// [[PARENT]]` could not heal an orphan — the reciprocal edge only ever
// appeared when the PARENT was independently synced. Root cause of every
// "sidebar orphan comes back after per-doc reconcile" bug.
//
// This spec creates that exact failure: a child with a valid Child of
// bullet pointing at a parent whose own Parent of is empty. It then runs
// per-doc reconcile on the child and asserts the parent→child hierarchy
// edge exists in doc_edges.
//
// Local-mode exercise per SPRINT-054 pattern.

import { expect, test } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reconcile } from "@/src/lib/mcp/tools/reconcile";
import type { ToolContext } from "@/src/lib/mcp/tools/types";
import { LOCAL_NAMESPACE } from "@/src/lib/mcp/tools/types";
import { localToolContext } from "@/src/lib/mcp/tools/context";

const PARENT_CONTENT = `# PARENT

> A parent whose Parent of is intentionally empty, mirroring the vault-drift
> shape where a child was authored but the parent never got a reciprocal
> bullet.

## Child of

* [[ROOT]]

## Parent of
`;

const CHILD_CONTENT = `# CHILD

> A child that declares its parent, but whose parent doesn't reciprocate.

## Child of

* [[PARENT]]

## Parent of
`;

const ROOT_CONTENT = `# ROOT

> Root anchor.

## Parent of

* [[PARENT]]
`;

test.describe("syncDocEdges reciprocal edges (SPRINT-181)", () => {
  let docsDir: string;
  let ctx: ToolContext;

  test.beforeEach(async () => {
    docsDir = await mkdtemp(path.join(tmpdir(), "emdee-reciprocal-"));
    await mkdir(docsDir, { recursive: true });
    await writeFile(path.join(docsDir, "ROOT.md"), ROOT_CONTENT, "utf8");
    await writeFile(path.join(docsDir, "PARENT.md"), PARENT_CONTENT, "utf8");
    await writeFile(path.join(docsDir, "CHILD.md"), CHILD_CONTENT, "utf8");
    ctx = localToolContext(docsDir);
  });

  test.afterEach(async () => {
    await rm(docsDir, { recursive: true, force: true });
  });

  test("per-doc reconcile of a child heals the missing parent→child edge", async () => {
    // Reconcile the child. Under the pre-SPRINT-181 code, this would leave
    // the parent→child edge missing because syncDocEdges only kept edges
    // where from_path === docPath.
    const raw = await reconcile(ctx, { path: "CHILD.md" });
    const result = JSON.parse((raw as { content: Array<{ text: string }> }).content[0].text);
    expect(result.ok).toBe(true);

    const inbound = await ctx.db.getEdges(LOCAL_NAMESPACE, { to_path: "CHILD.md" });
    const parentEdge = inbound.find((r) => r.from_path === "PARENT.md" && r.kind === "hierarchy");
    expect(parentEdge, "expected a PARENT.md → CHILD.md hierarchy edge after per-doc reconcile").toBeDefined();
  });

  test("existing parent→child edges are preserved by per-doc reconcile of a sibling", async () => {
    // Sanity check: reconciling an unrelated doc must not disturb the
    // healed edge. Reconcile CHILD first (heals), then reconcile ROOT
    // (unrelated), then confirm the edge is still there.
    await reconcile(ctx, { path: "CHILD.md" });
    await reconcile(ctx, { path: "ROOT.md" });

    const inbound = await ctx.db.getEdges(LOCAL_NAMESPACE, { to_path: "CHILD.md" });
    const parentEdge = inbound.find((r) => r.from_path === "PARENT.md" && r.kind === "hierarchy");
    expect(parentEdge).toBeDefined();
  });
});
