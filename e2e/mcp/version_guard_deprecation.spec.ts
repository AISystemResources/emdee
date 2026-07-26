// SPRINT-141d: soft deprecation on version-guard args.
// When any expected_*_content_hash arg is omitted, the tool still
// works but appends a deprecation_warnings array to the response.

import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendSection } from "@/src/lib/mcp/tools/append_section";
import { createChild } from "@/src/lib/mcp/tools/create_child";
import { addAssociation } from "@/src/lib/mcp/tools/add_association";
import { hashBody } from "@/src/lib/mcp/tools/sections";
import { localToolContext } from "@/src/lib/mcp/tools/context";

interface ToolCallResult { content: Array<{ type: "text"; text: string }>; }
function parse(raw: unknown): Record<string, unknown> {
  return JSON.parse((raw as ToolCallResult).content[0].text) as Record<string, unknown>;
}

test.describe("hash-arg soft deprecation (SPRINT-141d)", () => {
  let docsDir: string;
  test.beforeEach(() => {
    docsDir = join(tmpdir(), `emdee-dep-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(docsDir, { recursive: true });
  });
  test.afterEach(() => {
    try { rmSync(docsDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test("append_section without hash → success + deprecation_warnings", async () => {
    writeFileSync(join(docsDir, "x.md"), "# X\n\n## Notes\n\nbody\n");
    const ctx = localToolContext(docsDir);
    const r = parse(await appendSection(ctx, { path: "x.md", heading: "Notes", body: "more" }));
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.deprecation_warnings)).toBe(true);
    expect((r.deprecation_warnings as string[])[0]).toContain("expected_content_hash");
    expect((r.deprecation_warnings as string[])[0]).toContain("SPRINT-141d");
  });

  test("append_section WITH fresh hash → no deprecation_warnings", async () => {
    const content = "# X\n\n## Notes\n\nbody\n";
    writeFileSync(join(docsDir, "x.md"), content);
    const ctx = localToolContext(docsDir);
    const r = parse(await appendSection(ctx, {
      path: "x.md", heading: "Notes", body: "more",
      expected_content_hash: hashBody(content),
    }));
    expect(r.ok).toBe(true);
    expect(r.deprecation_warnings).toBeUndefined();
  });

  test("create_child without parent hash → deprecation_warnings", async () => {
    writeFileSync(join(docsDir, "P.md"), "# Parent\n\n## Parent of\n\n## Notes\n");
    const ctx = localToolContext(docsDir);
    const r = parse(await createChild(ctx, { parent_path: "P.md", title: "Kid" }));
    expect(r.ok).toBe(true);
    expect((r.deprecation_warnings as string[])[0]).toContain("expected_parent_content_hash");
  });

  test("add_association: warning lists ALL missing hash args", async () => {
    writeFileSync(join(docsDir, "A.md"), "# A\n\n## Notes\n");
    writeFileSync(join(docsDir, "B.md"), "# B\n\n## Notes\n");
    const ctx = localToolContext(docsDir);
    const r = parse(await addAssociation(ctx, { a_path: "A.md", b_path: "B.md" }));
    // Not exercising conflict — just checking the warning content.
    const warns = r.deprecation_warnings as string[] | undefined;
    expect(warns?.[0]).toContain("expected_a_content_hash");
    expect(warns?.[0]).toContain("expected_b_content_hash");
  });

  test("error responses do NOT get deprecation_warnings tacked on", async () => {
    const ctx = localToolContext(docsDir);
    // append_section on a missing doc → doc_not_found error, no warnings.
    const r = parse(await appendSection(ctx, {
      path: "does-not-exist.md", heading: "X", body: "y",
    }));
    expect(r.error).toBe("doc_not_found");
    expect(r.deprecation_warnings).toBeUndefined();
  });
});
