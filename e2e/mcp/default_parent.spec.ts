// SPRINT-190: default-to-owner enforcement.
//
// Covers the pure-function detection + injection logic. The wire-through
// on `write_doc` (MCP) + `PUT /api/doc` (editor) is covered by manual
// smoke against the deployed environment — those depend on the
// profiles table lookup which needs live DB.

import { expect, test } from "@playwright/test";
import { isOrphanContent, injectDefaultParent } from "@/src/lib/mcp/tools/default_parent";

test.describe("isOrphanContent (SPRINT-190)", () => {
  test("returns true when there's no Child of section at all", () => {
    const content = "# TITLE\n\n> summary\n\n## Notes\n\nbody\n";
    expect(isOrphanContent(content)).toBe(true);
  });

  test("returns true when Child of section exists but is empty", () => {
    const content = "# TITLE\n\n> summary\n\n## Child of\n\n## Parent of\n\n";
    expect(isOrphanContent(content)).toBe(true);
  });

  test("returns true when Child of body has only whitespace", () => {
    const content = "# TITLE\n\n## Child of\n\n   \n\t\n\n## Notes\n";
    expect(isOrphanContent(content)).toBe(true);
  });

  test("returns false when Child of has a wiki-link bullet", () => {
    const content = "# TITLE\n\n## Child of\n\n* [[OWNER]]\n\n## Notes\n";
    expect(isOrphanContent(content)).toBe(false);
  });

  test("returns false for a system node with `[[EMDEE]]`", () => {
    const content = "# VAULT\n\n> system\n\n## Child of\n\n* [[EMDEE]]\n";
    expect(isOrphanContent(content)).toBe(false);
  });
});

test.describe("injectDefaultParent (SPRINT-190)", () => {
  test("inserts full section when Child of is missing", () => {
    const before = "# NEW-DOC\n\n> summary\n\n## Notes\n\nbody\n";
    const after = injectDefaultParent(before, "LISA");
    expect(after).toContain("## Child of\n\n* [[LISA]]");
    expect(after.indexOf("## Child of")).toBeLessThan(after.indexOf("## Notes"));
  });

  test("inserts bullet when Child of exists but empty", () => {
    const before = "# TITLE\n\n## Child of\n\n## Parent of\n\n";
    const after = injectDefaultParent(before, "LISA");
    expect(after).toContain("## Child of\n\n\n* [[LISA]]\n");
    // Original Parent of section preserved
    expect(after).toContain("## Parent of");
  });

  test("no-op when Child of already has a bullet", () => {
    const before = "# TITLE\n\n## Child of\n\n* [[EXISTING]]\n\n## Notes\n";
    const after = injectDefaultParent(before, "LISA");
    expect(after).toBe(before);
  });

  test("no-op when Child of has multiple bullets", () => {
    const before = "# TITLE\n\n## Child of\n\n* [[A]]\n* [[B]]\n\n## Notes\n";
    const after = injectDefaultParent(before, "LISA");
    expect(after).toBe(before);
  });

  test("inserts before first H2 when no other structure", () => {
    const before = "# LONELY";
    const after = injectDefaultParent(before, "LISA");
    expect(after).toContain("## Child of\n\n* [[LISA]]");
  });
});
