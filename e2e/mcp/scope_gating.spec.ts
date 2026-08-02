// SPRINT-178: OAuth scope-gating enforcement coverage.
//
// Exercises scope-gate helpers directly (not the /api/mcp HTTP surface)
// so specs can run against a stub ToolContext without needing the OAuth
// authorize + token exchange dance. This is the same pattern the ticket
// specs use for validation-branch coverage — cheap, fast, hermetic.
//
// The dispatcher-level integration (assertToolScope called by
// /api/mcp/route.ts before every tool call) is covered by inference:
// the dispatcher wraps the same helpers exercised here, and every
// existing ticket / write test still passes with `scope: "mcp"` on the
// stub context (regression-guard against dispatcher breaking legacy).

import { expect, test } from "@playwright/test";
import {
  assertPathWriteScope,
  assertToolScope,
  assertUnrestrictedDocsWrite,
  describeScope,
  grantedWritePrefixes,
  hasScope,
  parseScopes,
  ScopeDeniedError,
  ALL_KNOWN_TOOLS,
  READ_TOOLS,
  PATH_WRITE_TOOLS,
  BULK_WRITE_TOOLS,
  TICKET_TOOLS,
  assertAllToolsClassified,
} from "@/src/lib/mcp/scopes";
import type { ToolContext } from "@/src/lib/mcp/tools/types";

function cloudCtx(scope: string): ToolContext {
  return {
    mode: "cloud",
    userId: "user_test",
    storage: {} as never,
    db: {} as never,
    scope,
  } as ToolContext;
}

function localCtx(): ToolContext {
  return { mode: "local", docsDir: "/tmp/x", db: {} as never } as ToolContext;
}

test.describe("scope parsing (SPRINT-178)", () => {
  test("parseScopes: whitespace-separated, empty-filtered", () => {
    expect(parseScopes("mcp")).toEqual(["mcp"]);
    expect(parseScopes("docs:read docs:write:edmund%2F")).toEqual(["docs:read", "docs:write:edmund%2F"]);
    expect(parseScopes("")).toEqual([]);
    expect(parseScopes(undefined)).toEqual([]);
    expect(parseScopes(null)).toEqual([]);
    expect(parseScopes("  a   b  ")).toEqual(["a", "b"]);
  });

  test("hasScope: legacy mcp short-circuits everything", () => {
    expect(hasScope("mcp", "docs:read")).toBe(true);
    expect(hasScope("mcp", "docs:write")).toBe(true);
    expect(hasScope("mcp", "tickets:cmo:create")).toBe(true);
    expect(hasScope("mcp", "totally_made_up")).toBe(true);
  });

  test("hasScope: specific match", () => {
    expect(hasScope("docs:read", "docs:read")).toBe(true);
    expect(hasScope("docs:read", "docs:write")).toBe(false);
    expect(hasScope("docs:read docs:write", "docs:write")).toBe(true);
  });

  test("grantedWritePrefixes: null for unrestricted, array for prefix-only", () => {
    expect(grantedWritePrefixes("mcp")).toBeNull();
    expect(grantedWritePrefixes("docs:write")).toBeNull();
    expect(grantedWritePrefixes("docs:read")).toEqual([]);
    expect(grantedWritePrefixes("")).toEqual([]);

    const prefixes = grantedWritePrefixes("docs:write:edmund%2F03-projects%2F02-whatelz_ai%2Fmarketing%2F");
    expect(prefixes).toEqual(["edmund/03-projects/02-whatelz_ai/marketing/"]);
  });

  test("grantedWritePrefixes: multiple prefixes combine", () => {
    const prefixes = grantedWritePrefixes("docs:write:a%2F docs:write:b%2F docs:read");
    expect(prefixes).toEqual(["a/", "b/"]);
  });

  test("grantedWritePrefixes: malformed scope claims are ignored, not thrown", () => {
    // Empty prefix
    expect(grantedWritePrefixes("docs:write:")).toEqual([]);
    // Malformed URL encoding
    expect(grantedWritePrefixes("docs:write:%GG")).toEqual([]);
  });
});

test.describe("assertPathWriteScope (SPRINT-178)", () => {
  test("mcp scope passes any path", () => {
    expect(() => assertPathWriteScope(cloudCtx("mcp"), "any/random/path.md")).not.toThrow();
  });

  test("bare docs:write scope passes any path", () => {
    expect(() => assertPathWriteScope(cloudCtx("docs:write"), "any/random/path.md")).not.toThrow();
  });

  test("prefix-only scope passes within prefix", () => {
    const ctx = cloudCtx("docs:write:edmund%2F03-projects%2F02-whatelz_ai%2Fmarketing%2F");
    expect(() => assertPathWriteScope(ctx, "edmund/03-projects/02-whatelz_ai/marketing/drafts/2026-08-02.md")).not.toThrow();
  });

  test("prefix-only scope denies outside prefix", () => {
    const ctx = cloudCtx("docs:write:edmund%2F03-projects%2F02-whatelz_ai%2Fmarketing%2F");
    expect(() => assertPathWriteScope(ctx, "edmund/03-projects/01-emdee_os/production/SPRINTS.md"))
      .toThrow(ScopeDeniedError);
  });

  test("empty scope denies any write", () => {
    expect(() => assertPathWriteScope(cloudCtx(""), "anywhere.md")).toThrow(ScopeDeniedError);
  });

  test("docs:read-only scope denies writes", () => {
    expect(() => assertPathWriteScope(cloudCtx("docs:read"), "anywhere.md")).toThrow(ScopeDeniedError);
  });

  test("local mode always passes", () => {
    expect(() => assertPathWriteScope(localCtx(), "anywhere.md")).not.toThrow();
  });

  test("thrown error carries structured detail", () => {
    try {
      assertPathWriteScope(cloudCtx("docs:read"), "foo.md");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ScopeDeniedError);
      expect((e as ScopeDeniedError).path).toBe("foo.md");
      expect((e as ScopeDeniedError).required).toContain("docs:write");
    }
  });
});

test.describe("assertUnrestrictedDocsWrite (SPRINT-178)", () => {
  test("mcp passes", () => {
    expect(() => assertUnrestrictedDocsWrite(cloudCtx("mcp"), "reconcile")).not.toThrow();
  });

  test("bare docs:write passes", () => {
    expect(() => assertUnrestrictedDocsWrite(cloudCtx("docs:write"), "reconcile")).not.toThrow();
  });

  test("prefix-only denies", () => {
    expect(() => assertUnrestrictedDocsWrite(cloudCtx("docs:write:foo%2F"), "reconcile"))
      .toThrow(ScopeDeniedError);
  });

  test("docs:read denies", () => {
    expect(() => assertUnrestrictedDocsWrite(cloudCtx("docs:read"), "reconcile"))
      .toThrow(ScopeDeniedError);
  });

  test("local mode passes", () => {
    expect(() => assertUnrestrictedDocsWrite(localCtx(), "reconcile")).not.toThrow();
  });
});

test.describe("assertToolScope (SPRINT-178)", () => {
  test("mcp passes every tool", () => {
    for (const tool of ALL_KNOWN_TOOLS) {
      expect(() => assertToolScope(cloudCtx("mcp"), tool)).not.toThrow();
    }
  });

  test("docs:read passes read tools, denies writes", () => {
    for (const tool of READ_TOOLS) {
      expect(() => assertToolScope(cloudCtx("docs:read"), tool), `${tool} should pass with docs:read`).not.toThrow();
    }
    for (const tool of PATH_WRITE_TOOLS) {
      expect(() => assertToolScope(cloudCtx("docs:read"), tool), `${tool} should deny with docs:read`).toThrow(ScopeDeniedError);
    }
    for (const tool of BULK_WRITE_TOOLS) {
      expect(() => assertToolScope(cloudCtx("docs:read"), tool), `${tool} should deny with docs:read`).toThrow(ScopeDeniedError);
    }
  });

  test("docs:write passes read + path-write + bulk tools", () => {
    const ctx = cloudCtx("docs:read docs:write");
    for (const tool of [...READ_TOOLS, ...PATH_WRITE_TOOLS, ...BULK_WRITE_TOOLS]) {
      expect(() => assertToolScope(ctx, tool), `${tool} should pass with docs:write`).not.toThrow();
    }
  });

  test("docs:write:<prefix> passes path-writes but denies bulk", () => {
    const ctx = cloudCtx("docs:write:edmund%2Fmarketing%2F");
    for (const tool of PATH_WRITE_TOOLS) {
      expect(() => assertToolScope(ctx, tool), `${tool} should pass with prefix-scoped write`).not.toThrow();
    }
    for (const tool of BULK_WRITE_TOOLS) {
      expect(() => assertToolScope(ctx, tool), `${tool} should deny with prefix-only`).toThrow(ScopeDeniedError);
    }
  });

  test("ticket tools pass at dispatcher (pillar-specific check happens inside)", () => {
    // No specific ticket scope needed at the dispatcher — the tools
    // themselves enforce tickets:<pillar>:create / :update.
    const ctx = cloudCtx("tickets:cmo:create");
    for (const tool of TICKET_TOOLS) {
      expect(() => assertToolScope(ctx, tool), `${tool} should pass dispatcher`).not.toThrow();
    }
  });

  test("unknown tool fails closed for scoped tokens", () => {
    expect(() => assertToolScope(cloudCtx("docs:read"), "future_new_tool"))
      .toThrow(ScopeDeniedError);
  });

  test("local mode passes every tool including unknown", () => {
    expect(() => assertToolScope(localCtx(), "anything")).not.toThrow();
    expect(() => assertToolScope(localCtx(), "unknown_tool_xyz")).not.toThrow();
  });
});

test.describe("classification invariants (SPRINT-178)", () => {
  test("no tool is in more than one category", () => {
    const seen = new Set<string>();
    const doubles: string[] = [];
    for (const set of [READ_TOOLS, PATH_WRITE_TOOLS, BULK_WRITE_TOOLS, TICKET_TOOLS]) {
      for (const tool of set) {
        if (seen.has(tool)) doubles.push(tool);
        seen.add(tool);
      }
    }
    expect(doubles, `double-classified: ${doubles.join(", ")}`).toEqual([]);
  });

  test("every case name in app/api/mcp/route.ts dispatcher is scope-classified", async () => {
    // The real drift risk we're guarding: a future PR adds
    // `case "new_tool": return await newTool(ctx, a) as CallToolResult;`
    // to the dispatcher switch WITHOUT adding the tool name to any of
    // the scope classification sets. In production, scoped tokens hit
    // the fail-closed dispatcher branch (throw ScopeDeniedError with
    // required="unclassified_tool..."); legacy `mcp` tokens still work.
    // Silent from any tautological unit test.
    //
    // This test reads route.ts source, regexes out every `case "..":`
    // in the switch, and asserts each is in exactly one classification
    // set. Adding a tool without scoping = red test.
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("../../app/api/mcp/route.ts", import.meta.url), "utf8");
    const caseRe = /case\s+"([a-z_]+)":/g;
    const registeredTools: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = caseRe.exec(source)) !== null) {
      registeredTools.push(m[1]);
    }
    expect(registeredTools.length, "dispatcher switch parsed at least one tool").toBeGreaterThan(30);
    expect(() => assertAllToolsClassified(registeredTools)).not.toThrow();
  });

  test("ALL_KNOWN_TOOLS covers everything the dispatcher registers", async () => {
    // Belt-and-suspenders: any tool in the switch must also appear in
    // scopes.ts's ALL_KNOWN_TOOLS. Catches the case where someone adds
    // a tool to one specific classification set but forgets to include
    // it in the ALL_KNOWN_TOOLS union computation.
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("../../app/api/mcp/route.ts", import.meta.url), "utf8");
    const caseRe = /case\s+"([a-z_]+)":/g;
    const orphans: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = caseRe.exec(source)) !== null) {
      if (!ALL_KNOWN_TOOLS.has(m[1])) orphans.push(m[1]);
    }
    expect(orphans, `not in ALL_KNOWN_TOOLS: ${orphans.join(", ")}`).toEqual([]);
  });
});

test.describe("describeScope (SPRINT-178)", () => {
  test("known static scopes carry descriptions", () => {
    expect(describeScope("mcp").known).toBe(true);
    expect(describeScope("mcp").dangerous).toBe(true);
    expect(describeScope("docs:read").known).toBe(true);
    expect(describeScope("docs:read").dangerous).toBe(false);
    expect(describeScope("docs:write").known).toBe(true);
    expect(describeScope("docs:write").dangerous).toBe(true);
  });

  test("prefix-scoped writes are known + not dangerous", () => {
    const d = describeScope("docs:write:edmund%2Fmarketing%2F");
    expect(d.known).toBe(true);
    expect(d.dangerous).toBe(false);
    expect(d.label).toContain("edmund/marketing/");
  });

  test("pillar ticket scopes render pillar in label", () => {
    expect(describeScope("tickets:cmo:create").label).toContain("CMO");
    expect(describeScope("tickets:coo:update").label).toContain("COO");
  });

  test("unknown scope is flagged as dangerous + not known", () => {
    const d = describeScope("garbage:whatever:x");
    expect(d.known).toBe(false);
    expect(d.dangerous).toBe(true);
    expect(d.label).toContain("Unrecognised");
  });

  test("malformed docs:write scope is flagged", () => {
    const d = describeScope("docs:write:%GG");
    expect(d.dangerous).toBe(true);
    expect(d.label).toContain("Malformed");
  });
});
