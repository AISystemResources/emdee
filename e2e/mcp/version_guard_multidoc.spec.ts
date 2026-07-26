// SPRINT-141b: multi-doc version guards on create_child / add_association /
// move_doc / trash_doc / materialize_subgroup. One spec per tool: stale hash
// on any guarded doc → conflict with the failing doc's path; fresh (or
// omitted) → proceeds.

import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createChild } from "@/src/lib/mcp/tools/create_child";
import { addAssociation } from "@/src/lib/mcp/tools/add_association";
import { moveDoc } from "@/src/lib/mcp/tools/move_doc";
import { trashDoc } from "@/src/lib/mcp/tools/trash_doc";
import { materializeSubgroup } from "@/src/lib/mcp/tools/materialize_subgroup";
import { hashBody } from "@/src/lib/mcp/tools/sections";
import { localToolContext } from "@/src/lib/mcp/tools/context";

interface ToolCallResult { content: Array<{ type: "text"; text: string }>; }
function parse(raw: unknown): Record<string, unknown> {
  const r = raw as ToolCallResult;
  return JSON.parse(r.content[0].text) as Record<string, unknown>;
}

const STALE = "0000000000000000";

function makeVault(): string {
  const dir = join(tmpdir(), `emdee-mguard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test.describe("multi-doc version guards (SPRINT-141b)", () => {
  let docsDir: string;
  test.beforeEach(() => { docsDir = makeVault(); });
  test.afterEach(() => { try { rmSync(docsDir, { recursive: true, force: true }); } catch { /* ignore */ } });

  test("create_child: stale parent hash → conflict on parent path", async () => {
    const parent = "# ROOT\n\n## Parent of\n\n## Notes\n";
    writeFileSync(join(docsDir, "ROOT.md"), parent);
    const ctx = localToolContext(docsDir);

    const stale = parse(await createChild(ctx, {
      parent_path: "ROOT.md", title: "New Child", expected_parent_content_hash: STALE,
    }));
    expect(stale.error).toBe("stale_content");
    expect(stale.path).toBe("ROOT.md");

    const ok = parse(await createChild(ctx, {
      parent_path: "ROOT.md", title: "New Child",
      expected_parent_content_hash: hashBody(parent),
    }));
    expect(ok.ok).toBe(true);
  });

  test("add_association: stale on either side → conflict with that side's path", async () => {
    const a = "# A\n\n## Notes\n";
    const b = "# B\n\n## Notes\n";
    writeFileSync(join(docsDir, "A.md"), a);
    writeFileSync(join(docsDir, "B.md"), b);
    const ctx = localToolContext(docsDir);

    const staleA = parse(await addAssociation(ctx, {
      a_path: "A.md", b_path: "B.md",
      expected_a_content_hash: STALE,
    }));
    expect(staleA.error).toBe("stale_content");
    expect(staleA.path).toBe("A.md");

    const staleB = parse(await addAssociation(ctx, {
      a_path: "A.md", b_path: "B.md",
      expected_a_content_hash: hashBody(a),
      expected_b_content_hash: STALE,
    }));
    expect(staleB.error).toBe("stale_content");
    expect(staleB.path).toBe("B.md");

    const ok = parse(await addAssociation(ctx, {
      a_path: "A.md", b_path: "B.md",
      expected_a_content_hash: hashBody(a),
      expected_b_content_hash: hashBody(b),
    }));
    expect(ok.error).not.toBe("stale_content");
  });

  test("move_doc: stale on any of child/old-parent/new-parent → conflict with that path", async () => {
    const oldParent = "# OLD\n\n## Parent of\n\n* [[Kid]]\n";
    const newParent = "# NEW\n\n## Parent of\n";
    const child = "# Kid\n\n## Child of\n\n* [[OLD]]\n";
    writeFileSync(join(docsDir, "OLD.md"), oldParent);
    writeFileSync(join(docsDir, "NEW.md"), newParent);
    writeFileSync(join(docsDir, "KID.md"), child);
    const ctx = localToolContext(docsDir);

    const stale = parse(await moveDoc(ctx, {
      path: "KID.md", new_parent_path: "NEW.md",
      expected_child_content_hash: hashBody(child),
      expected_old_parent_content_hash: STALE,
      expected_new_parent_content_hash: hashBody(newParent),
    }));
    expect(stale.error).toBe("stale_content");
    expect(stale.path).toBe("OLD.md");
  });

  test("trash_doc: stale content hash → conflict", async () => {
    const content = "# TARGET\n\n## Child of\n\n* [[ROOT]]\n";
    writeFileSync(join(docsDir, "TARGET.md"), content);
    writeFileSync(join(docsDir, "ROOT.md"), "# ROOT\n\n## Parent of\n\n* [[TARGET]]\n");
    const ctx = localToolContext(docsDir);

    const stale = parse(await trashDoc(ctx, {
      path: "TARGET.md", expected_content_hash: STALE,
    }));
    expect(stale.error).toBe("stale_content");
    expect(stale.path).toBe("TARGET.md");
  });

  test("materialize_subgroup: stale source hash → conflict", async () => {
    // Minimal source with an H3 subgroup + one child bullet resolving to a real doc.
    const source = [
      "# SRC",
      "",
      "## Parent of",
      "",
      "### Sub A",
      "",
      "* [[Kid]]",
      "",
    ].join("\n");
    writeFileSync(join(docsDir, "SRC.md"), source);
    writeFileSync(join(docsDir, "KID.md"), "# Kid\n\n## Child of\n\n* [[SRC]]\n");
    const ctx = localToolContext(docsDir);

    const stale = parse(await materializeSubgroup(ctx, {
      source_path: "SRC.md", subgroup_heading: "Sub A",
      expected_source_content_hash: STALE,
    }));
    expect(stale.error).toBe("stale_content");
    expect(stale.path).toBe("SRC.md");
    // Ensure no new doc was written.
    const untouchedSrc = readFileSync(join(docsDir, "SRC.md"), "utf8");
    expect(untouchedSrc).toBe(source);
  });
});
