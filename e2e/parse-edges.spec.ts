// SPRINT-063: parseEdges + indexer must keep accruing bullets through
// H3 sub-headings nested inside a `## Parent of` section.
//
// Symptom that motivated this test: SFPDI-DAY1-MECHANICS.md groups its
// child bullets under `### Vocabulary & units`, `### Leverage & margin`,
// `### Market structure & carrying costs`. The pre-fix parser hit the
// first `###`, reset its "in Parent of" flag to null, and silently
// dropped every child bullet. The leaf docs (Points, Margin, Leverage,
// Market Types, …) then surfaced as top-level orphans in the sidebar
// because their hierarchy edge was never produced.

import { expect, test } from "@playwright/test";
import { parseEdges } from "@/src/core/parseEdges";
import { buildIndexFromContents } from "@/src/core/indexer";

const NESTED_PARENT_OF = `# SFPDI — DAY1 — Mechanics

> Test fixture.

## Child of

* [[SFPDI-DAY1]]

## Parent of

### Vocabulary & units

* [[Points]] — unit of measurement
* [[Market Vocabulary]] — basic lexicon

### Leverage & margin

* [[Leverage]] — multiplier
* [[Margin]] — deposit side

### Market structure & carrying costs

* [[Market Types]] — Rolling vs Futures

## Notes

* [[Should Not Be A Child]]
`;

test.describe("parseEdges — sub-headings inside Parent of", () => {
  test("H3 sub-sections inside ## Parent of keep accruing child bullets", () => {
    const edges = parseEdges(NESTED_PARENT_OF);
    const children = edges.filter((e) => e.kind === "parent_of").map((e) => e.target);
    expect(children).toEqual([
      "Points",
      "Market Vocabulary",
      "Leverage",
      "Margin",
      "Market Types",
    ]);
  });

  test("position numbering is monotonic across sub-headings", () => {
    const edges = parseEdges(NESTED_PARENT_OF);
    const positions = edges
      .filter((e) => e.kind === "parent_of")
      .map((e) => e.position);
    // Continuous 0..4 — sub-headings don't reset; preserves overall
    // bullet order for prev/next sibling navigation.
    expect(positions).toEqual([0, 1, 2, 3, 4]);
  });

  test("equal-level ## heading exits the Parent of section", () => {
    const edges = parseEdges(NESTED_PARENT_OF);
    // [[Should Not Be A Child]] appears under `## Notes` after `## Parent of`.
    // A sibling H2 must terminate the Parent of capture.
    const targets = edges.map((e) => e.target);
    expect(targets).not.toContain("Should Not Be A Child");
  });

  test("Child of bullet still parses through the Parent of sub-heading run", () => {
    const edges = parseEdges(NESTED_PARENT_OF);
    const parents = edges.filter((e) => e.kind === "child_of").map((e) => e.target);
    expect(parents).toEqual(["SFPDI-DAY1"]);
  });
});

test.describe("indexer.extractSections — same fix applied", () => {
  test("buildIndexFromContents emits hierarchy edges for all 5 nested children", () => {
    const parent = {
      path: "events/seminars/SFPDI/SFPDI-DAY1-MECHANICS.md",
      content: NESTED_PARENT_OF,
    };
    const stubs = ["Points", "Market Vocabulary", "Leverage", "Margin", "Market Types"]
      .map((title) => ({
        path: `events/seminars/SFPDI/DAY1/${title.toUpperCase().replace(/ /g, "-")}.md`,
        content: `# ${title}\n\n> stub.\n\n## Child of\n\n* [[SFPDI — DAY1 — Mechanics]]\n`,
      }));
    const dayParent = {
      path: "events/seminars/SFPDI/SFPDI-DAY1.md",
      content: `# SFPDI-DAY1\n\n> stub.\n\n## Parent of\n\n* [[SFPDI — DAY1 — Mechanics]]\n`,
    };
    const idx = buildIndexFromContents([parent, dayParent, ...stubs]);
    const hierFromMechanics = idx.edges.filter(
      (e) => e.kind === "hierarchy" && e.from === parent.path,
    );
    expect(hierFromMechanics).toHaveLength(5);
  });
});
