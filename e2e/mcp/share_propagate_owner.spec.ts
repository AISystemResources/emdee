// SPRINT-163: HARD RULE 11 regression spec for owner-write share propagation.
//
// Motivation: cascading shares only capture descendants that existed AT
// SHARE-TIME. When the owner later adds new docs under the shared
// subtree, grantees don't get shares for them and see the new docs as
// orphans (or don't see them at all). Sim Yee's DOUBLELEAD P/M/O hubs
// were the trigger — added months after the initial DL share, they
// never propagated, so her sidebar showed the leaves flat at root.
//
// This spec pins the pure dedup + upgrade logic used inside
// propagateOwnerWriteToShares. The DB-touching part is exercised
// separately by the runtime once writes flow through the share-having
// namespace.

import { expect, test } from "@playwright/test";
import {
  buildOwnerSharePropagationInserts,
  type OwnerShareMatch,
} from "@/src/lib/mcp/tools/vault";

const OWNER = "user_owner_abc";
const NEW_PATH = "edmund/projects/doublelead/production/PRODUCTION.md";

test.describe("buildOwnerSharePropagationInserts (SPRINT-163)", () => {
  test("empty matches → empty inserts", () => {
    expect(buildOwnerSharePropagationInserts([], NEW_PATH, OWNER)).toEqual([]);
  });

  test("null share_root rows are dropped (only cascading shares propagate)", () => {
    const matches: OwnerShareMatch[] = [
      { share_root: null, grantee_id: "g1", permission: "write" },
    ];
    expect(buildOwnerSharePropagationInserts(matches, NEW_PATH, OWNER)).toEqual([]);
  });

  test("one grantee, one share_root → one insert", () => {
    const matches: OwnerShareMatch[] = [
      { share_root: "edmund/projects/DOUBLELEAD.md", grantee_id: "g1", permission: "write" },
    ];
    const inserts = buildOwnerSharePropagationInserts(matches, NEW_PATH, OWNER);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toEqual({
      owner_id: OWNER,
      grantee_id: "g1",
      path_prefix: NEW_PATH,
      permission: "write",
      share_root: "edmund/projects/DOUBLELEAD.md",
    });
  });

  test("dedupes multiple hits for the same (grantee, share_root)", () => {
    const matches: OwnerShareMatch[] = [
      { share_root: "edmund/projects/DOUBLELEAD.md", grantee_id: "g1", permission: "read" },
      { share_root: "edmund/projects/DOUBLELEAD.md", grantee_id: "g1", permission: "read" },
      { share_root: "edmund/projects/DOUBLELEAD.md", grantee_id: "g1", permission: "read" },
    ];
    const inserts = buildOwnerSharePropagationInserts(matches, NEW_PATH, OWNER);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].permission).toBe("read");
  });

  test("write beats read for the same (grantee, share_root)", () => {
    const matches: OwnerShareMatch[] = [
      { share_root: "edmund/projects/DOUBLELEAD.md", grantee_id: "g1", permission: "read" },
      { share_root: "edmund/projects/DOUBLELEAD.md", grantee_id: "g1", permission: "write" },
    ];
    const inserts = buildOwnerSharePropagationInserts(matches, NEW_PATH, OWNER);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].permission).toBe("write");
  });

  test("multiple grantees under same share_root → one insert per grantee", () => {
    const matches: OwnerShareMatch[] = [
      { share_root: "edmund/projects/DOUBLELEAD.md", grantee_id: "sim_yee", permission: "write" },
      { share_root: "edmund/projects/DOUBLELEAD.md", grantee_id: "lisa", permission: "read" },
      { share_root: "edmund/projects/DOUBLELEAD.md", grantee_id: "jasbir", permission: "write" },
    ];
    const inserts = buildOwnerSharePropagationInserts(matches, NEW_PATH, OWNER);
    expect(inserts).toHaveLength(3);
    const byGrantee = Object.fromEntries(inserts.map((i) => [i.grantee_id, i.permission]));
    expect(byGrantee).toEqual({ sim_yee: "write", lisa: "read", jasbir: "write" });
  });

  test("same grantee under two different share_roots → separate inserts", () => {
    const matches: OwnerShareMatch[] = [
      { share_root: "edmund/projects/DOUBLELEAD.md", grantee_id: "g1", permission: "write" },
      { share_root: "edmund/projects/ATLAS.md", grantee_id: "g1", permission: "read" },
    ];
    const inserts = buildOwnerSharePropagationInserts(matches, NEW_PATH, OWNER);
    expect(inserts).toHaveLength(2);
    expect(inserts.map((i) => i.share_root).sort()).toEqual([
      "edmund/projects/ATLAS.md",
      "edmund/projects/DOUBLELEAD.md",
    ]);
  });
});
