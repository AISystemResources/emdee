// SPRINT-060 (SIG-007 part B): resolveWikiLink owner-scoping spec.
//
// Pure unit test of the resolver — feeds synthetic DocIndex fixtures
// with own + shared docs sharing the same title, asserts the resolver
// picks the same-namespace candidate based on the linking doc's path.

import { expect, test } from "@playwright/test";
import { resolveWikiLink } from "@/src/core/resolveLink";
import type { DocIndex, DocNode } from "@/src/core/indexer";

function makeDoc(path: string, title: string): DocNode {
  return {
    path,
    title,
    content: "",
    summary: "",
    parents: [],
    children: [],
    associates: [],
    mentions: [],
  };
}

function makeIndex(docs: DocNode[]): DocIndex {
  return { docs, edges: [], entry: docs[0]?.path ?? null };
}

const OWN_DAYTRADING = makeDoc("DAYTRADING.md", "DAYTRADING");
const SHARED_ALICE_DAYTRADING = makeDoc("__shared:user_alice:daytrading.md", "DAYTRADING");
const SHARED_BOB_DAYTRADING = makeDoc("__shared:user_bob:daytrading.md", "DAYTRADING");
const OWN_LINKER = makeDoc("notes/PORTFOLIO.md", "PORTFOLIO");
const SHARED_ALICE_LINKER = makeDoc("__shared:user_alice:JOURNAL.md", "JOURNAL");
const SHARED_BOB_LINKER = makeDoc("__shared:user_bob:JOURNAL.md", "JOURNAL");

test.describe("resolveWikiLink owner-scoping (local-mode)", () => {
  test("own doc linking [[DAYTRADING]] resolves to own when both own + shared exist", () => {
    const idx = makeIndex([OWN_DAYTRADING, SHARED_ALICE_DAYTRADING, OWN_LINKER]);
    const resolved = resolveWikiLink(idx, "DAYTRADING", "notes/PORTFOLIO.md");
    expect(resolved?.path).toBe("DAYTRADING.md");
  });

  test("shared doc (Alice) linking [[DAYTRADING]] resolves to Alice's shared, not own", () => {
    const idx = makeIndex([OWN_DAYTRADING, SHARED_ALICE_DAYTRADING, SHARED_ALICE_LINKER]);
    const resolved = resolveWikiLink(idx, "DAYTRADING", "__shared:user_alice:JOURNAL.md");
    expect(resolved?.path).toBe("__shared:user_alice:daytrading.md");
  });

  test("shared doc (Bob) linking [[DAYTRADING]] resolves to Bob's, not Alice's", () => {
    const idx = makeIndex([
      SHARED_ALICE_DAYTRADING,
      SHARED_BOB_DAYTRADING,
      SHARED_BOB_LINKER,
    ]);
    const resolved = resolveWikiLink(idx, "DAYTRADING", "__shared:user_bob:JOURNAL.md");
    expect(resolved?.path).toBe("__shared:user_bob:daytrading.md");
  });

  test("only one match — single-result fast path unchanged (cross-family is OK)", () => {
    // Just one DAYTRADING (shared from Alice). Own doc linking to it
    // resolves cross-family because there's no own DAYTRADING to prefer.
    // This is the documented fall-through behaviour — single match wins.
    const idx = makeIndex([SHARED_ALICE_DAYTRADING, OWN_LINKER]);
    const resolved = resolveWikiLink(idx, "DAYTRADING", "notes/PORTFOLIO.md");
    expect(resolved?.path).toBe("__shared:user_alice:daytrading.md");
  });

  test("no matches resolves to null", () => {
    const idx = makeIndex([OWN_DAYTRADING, OWN_LINKER]);
    const resolved = resolveWikiLink(idx, "NONEXISTENT", "notes/PORTFOLIO.md");
    expect(resolved).toBeNull();
  });

  test("no fromPath — first match wins (legacy behaviour)", () => {
    const idx = makeIndex([SHARED_ALICE_DAYTRADING, OWN_DAYTRADING]);
    const resolved = resolveWikiLink(idx, "DAYTRADING");
    // titleMatches has 2; pickByLocality with no fromPath returns
    // candidates[0] (the legacy fast-path).
    expect(resolved?.path).toBe("__shared:user_alice:daytrading.md");
  });

  test("own doc with two cross-shared matches — falls through to cross-family pool", () => {
    // Own linker, but no own DAYTRADING. Two shared candidates from
    // different owners. Same-family filter leaves zero own candidates
    // → falls through to the original locality pool (all shared).
    const idx = makeIndex([
      SHARED_ALICE_DAYTRADING,
      SHARED_BOB_DAYTRADING,
      OWN_LINKER,
    ]);
    const resolved = resolveWikiLink(idx, "DAYTRADING", "notes/PORTFOLIO.md");
    // Either ALICE or BOB is acceptable as a result — what matters is
    // that the resolver doesn't throw and returns one of them.
    expect(["__shared:user_alice:daytrading.md", "__shared:user_bob:daytrading.md"])
      .toContain(resolved?.path);
  });

  test("slug-fallback path also respects owner-scoping", () => {
    // Same titles as filenames; both share the title "ALPHA" via slug
    // fallback when the H1 doesn't match.
    const own = makeDoc("ALPHA.md", "Different Title");
    const shared = makeDoc("__shared:user_alice:ALPHA.md", "Also Different");
    const idx = makeIndex([own, shared, OWN_LINKER]);
    // Wiki-link `[[ALPHA]]` from own linker should hit own via slug fallback.
    const resolved = resolveWikiLink(idx, "ALPHA", "notes/PORTFOLIO.md");
    expect(resolved?.path).toBe("ALPHA.md");
  });
});
