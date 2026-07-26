// SPRINT-142: exercise the pure planner in sync-command.ts.
// The network-touching parts (enumerateCloud, pushLocalDoc, etc.) need
// a live cloud endpoint; this spec covers the diff algorithm that
// decides push / pull / conflict / skip / delete-warning per doc.

import { expect, test } from "@playwright/test";
import { planActions } from "@/src/cli/sync-command";

interface Manifest { [p: string]: { local_hash: string; cloud_hash: string; synced_at: string } }

const m = (local: string, cloud: string): Manifest[string] => ({ local_hash: local, cloud_hash: cloud, synced_at: "t" });

test.describe("sync planner (SPRINT-142)", () => {
  test("no manifest, doc only local → push", () => {
    const plan = planActions(new Map([["A.md", "h1"]]), new Map(), {});
    expect(plan).toHaveLength(1);
    expect(plan[0].path).toBe("A.md");
    expect(plan[0].action.kind).toBe("push");
  });

  test("no manifest, doc only cloud → pull", () => {
    const plan = planActions(new Map(), new Map([["A.md", "h1"]]), {});
    expect(plan[0].action.kind).toBe("pull");
  });

  test("no manifest, both sides identical → skip", () => {
    const plan = planActions(new Map([["A.md", "h1"]]), new Map([["A.md", "h1"]]), {});
    expect(plan[0].action.kind).toBe("skip");
  });

  test("no manifest, both sides differ → conflict", () => {
    const plan = planActions(new Map([["A.md", "h1"]]), new Map([["A.md", "h2"]]), {});
    expect(plan[0].action.kind).toBe("conflict");
  });

  test("manifest, only local changed → push", () => {
    const mf: Manifest = { "A.md": m("h1", "h1") };
    const plan = planActions(new Map([["A.md", "h2"]]), new Map([["A.md", "h1"]]), mf);
    expect(plan[0].action.kind).toBe("push");
    if (plan[0].action.kind === "push") {
      expect(plan[0].action.expectedCloudHash).toBe("h1");
    }
  });

  test("manifest, only cloud changed → pull", () => {
    const mf: Manifest = { "A.md": m("h1", "h1") };
    const plan = planActions(new Map([["A.md", "h1"]]), new Map([["A.md", "h2"]]), mf);
    expect(plan[0].action.kind).toBe("pull");
  });

  test("manifest, both changed → conflict", () => {
    const mf: Manifest = { "A.md": m("h1", "h1") };
    const plan = planActions(new Map([["A.md", "h2"]]), new Map([["A.md", "h3"]]), mf);
    expect(plan[0].action.kind).toBe("conflict");
  });

  test("manifest, neither changed → skip unchanged", () => {
    const mf: Manifest = { "A.md": m("h1", "h1") };
    const plan = planActions(new Map([["A.md", "h1"]]), new Map([["A.md", "h1"]]), mf);
    expect(plan[0].action.kind).toBe("skip");
  });

  test("previously-synced doc missing from local → delete_local_missing (deferred)", () => {
    const mf: Manifest = { "A.md": m("h1", "h1") };
    const plan = planActions(new Map(), new Map([["A.md", "h1"]]), mf);
    expect(plan[0].action.kind).toBe("delete_local_missing");
  });

  test("previously-synced doc missing from cloud → delete_cloud_missing (deferred)", () => {
    const mf: Manifest = { "A.md": m("h1", "h1") };
    const plan = planActions(new Map([["A.md", "h1"]]), new Map(), mf);
    expect(plan[0].action.kind).toBe("delete_cloud_missing");
  });

  test("multi-doc: mixed states are all planned in one pass", () => {
    const mf: Manifest = {
      "unchanged.md": m("h1", "h1"),
      "local-only-changed.md": m("h2", "h2"),
      "cloud-only-changed.md": m("h3", "h3"),
      "both-changed.md": m("h4", "h4"),
    };
    const local = new Map([
      ["unchanged.md", "h1"],
      ["local-only-changed.md", "hX"],
      ["cloud-only-changed.md", "h3"],
      ["both-changed.md", "hY"],
      ["new-local.md", "hZ"],
    ]);
    const cloud = new Map([
      ["unchanged.md", "h1"],
      ["local-only-changed.md", "h2"],
      ["cloud-only-changed.md", "hW"],
      ["both-changed.md", "hV"],
      ["new-cloud.md", "hU"],
    ]);
    const plan = planActions(local, cloud, mf);
    const byPath = Object.fromEntries(plan.map((p) => [p.path, p.action.kind]));
    expect(byPath["unchanged.md"]).toBe("skip");
    expect(byPath["local-only-changed.md"]).toBe("push");
    expect(byPath["cloud-only-changed.md"]).toBe("pull");
    expect(byPath["both-changed.md"]).toBe("conflict");
    expect(byPath["new-local.md"]).toBe("push");
    expect(byPath["new-cloud.md"]).toBe("pull");
  });
});
