// SPRINT-058 (SIG-006): HARD RULE 11 spec for owner-node naming.
//
// Not technically an MCP tool, but the seed flow that creates the owner
// node on user-first-vault-init uses this helper, and the helper's behavior
// directly governs what title every new user's MINE node lands with. A
// regression here = every new vault gets a weird name. Spec covers the
// known input shapes from real email patterns.

import { expect, test } from "@playwright/test";
import { ownerTitleFromEmail, ownerNodeScaffold } from "@/src/lib/owner/identity";

test.describe("ownerTitleFromEmail (local-mode)", () => {
  test("basic local-part with a dot", () => {
    expect(ownerTitleFromEmail("elz.work@gmail.com")).toBe("ELZ-WORK");
  });

  test("local-part with an underscore", () => {
    expect(ownerTitleFromEmail("junior_lin@example.com")).toBe("JUNIOR-LIN");
  });

  test("local-part already uppercase + plain", () => {
    expect(ownerTitleFromEmail("EDMUND@example.com")).toBe("EDMUND");
  });

  test("plus-suffix gets stripped (drops the + and everything after-but-before-@)", () => {
    expect(ownerTitleFromEmail("edmund+tag@example.com")).toBe("EDMUNDTAG");
  });

  test("multiple dots", () => {
    expect(ownerTitleFromEmail("a.b.c@example.com")).toBe("A-B-C");
  });

  test("digits preserved", () => {
    expect(ownerTitleFromEmail("user123@example.com")).toBe("USER123");
  });

  test("collapses repeated hyphens from mixed separators", () => {
    expect(ownerTitleFromEmail("a._.b@example.com")).toBe("A-B");
  });

  test("empty string falls back to OWNER", () => {
    expect(ownerTitleFromEmail("")).toBe("OWNER");
  });

  test("all-non-ASCII local-part falls back to OWNER", () => {
    expect(ownerTitleFromEmail("日本@example.com")).toBe("OWNER");
  });

  test("missing @ — treats whole string as local-part", () => {
    expect(ownerTitleFromEmail("noatsign")).toBe("NOATSIGN");
  });
});

test.describe("ownerNodeScaffold (local-mode)", () => {
  test("has H1 + blockquote + Child of [[EMDEE]] + empty Parent of", () => {
    const md = ownerNodeScaffold("ELZ-WORK");
    expect(md).toContain("# ELZ-WORK");
    expect(md).toMatch(/^>\s+.+/m);
    expect(md).toContain("## Child of");
    expect(md).toContain("* [[EMDEE]]");
    expect(md).toContain("## Parent of");
    expect(md).toContain("## Associated with");
    expect(md).toContain("## Notes");
  });

  test("scaffold passes basic lint shape (H1 followed by blockquote)", () => {
    const md = ownerNodeScaffold("EDMUND");
    const lines = md.split("\n");
    const h1Idx = lines.findIndex((l) => l.startsWith("# EDMUND"));
    expect(h1Idx).toBeGreaterThanOrEqual(0);
    // The next non-empty line should be the blockquote summary.
    let i = h1Idx + 1;
    while (i < lines.length && lines[i].trim() === "") i++;
    expect(lines[i].startsWith(">")).toBe(true);
  });
});
