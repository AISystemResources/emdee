// SPRINT-141a: universal doc-level version guard on single-doc write tools.
// One spec per tool: stale hash → conflict; fresh hash → succeeds; no hash → still works (backwards compat).

import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendSection } from "@/src/lib/mcp/tools/append_section";
import { appendDoc } from "@/src/lib/mcp/tools/append_doc";
import { writeDoc } from "@/src/lib/mcp/tools/write_doc";
import { deleteDoc } from "@/src/lib/mcp/tools/delete_doc";
import { splitDoc } from "@/src/lib/mcp/tools/split_doc";
import { hashBody } from "@/src/lib/mcp/tools/sections";
import { localToolContext } from "@/src/lib/mcp/tools/context";

interface ToolCallResult { content: Array<{ type: "text"; text: string }>; }
function parse(raw: unknown): Record<string, unknown> {
  const r = raw as ToolCallResult;
  return JSON.parse(r.content[0].text) as Record<string, unknown>;
}

const STALE = "0000000000000000";

function makeVault(): string {
  const dir = join(tmpdir(), `emdee-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test.describe("universal doc-level version guard (SPRINT-141a)", () => {
  let docsDir: string;
  test.beforeEach(() => { docsDir = makeVault(); });
  test.afterEach(() => { try { rmSync(docsDir, { recursive: true, force: true }); } catch { /* ignore */ } });

  test("append_section: stale hash → conflict; fresh → ok; omitted → ok", async () => {
    const content = "# X\n\n## Notes\n\nbody\n";
    writeFileSync(join(docsDir, "x.md"), content);
    const ctx = localToolContext(docsDir);
    const fresh = hashBody(content);

    const stale = parse(await appendSection(ctx, { path: "x.md", heading: "Notes", body: "more", expected_content_hash: STALE }));
    expect(stale.error).toBe("stale_content");
    expect(stale.actual_content_hash).toBe(fresh);
    expect(stale.current_content_preview).toContain("# X");

    const ok = parse(await appendSection(ctx, { path: "x.md", heading: "Notes", body: "more", expected_content_hash: fresh }));
    expect(ok.ok).toBe(true);

    const nohash = parse(await appendSection(ctx, { path: "x.md", heading: "Notes", body: "still more" }));
    expect(nohash.ok).toBe(true);
  });

  test("append_doc: stale → conflict; fresh → ok", async () => {
    const content = "# X\n\n## Notes\n\nbody\n";
    writeFileSync(join(docsDir, "x.md"), content);
    const ctx = localToolContext(docsDir);
    const fresh = hashBody(content);

    const stale = parse(await appendDoc(ctx, { path: "x.md", body: "tail", expected_content_hash: STALE }));
    expect(stale.error).toBe("stale_content");

    const ok = parse(await appendDoc(ctx, { path: "x.md", body: "tail", expected_content_hash: fresh }));
    expect(ok.ok).toBe(true);
  });

  test("write_doc: stale → conflict on overwrite; fresh → ok; new-doc creation guard-passthrough", async () => {
    const content = "# EXISTS\n\n## Notes\n\nbody\n";
    writeFileSync(join(docsDir, "EXISTS.md"), content);
    const ctx = localToolContext(docsDir);
    const fresh = hashBody(content);

    const stale = parse(await writeDoc(ctx, { path: "EXISTS.md", content: "# EXISTS\n\n## Notes\n\nnew\n", expected_content_hash: STALE }));
    expect(stale.error).toBe("stale_content");

    const ok = parse(await writeDoc(ctx, { path: "EXISTS.md", content: "# EXISTS\n\n## Notes\n\nnew\n", expected_content_hash: fresh }));
    expect(ok.ok).toBe(true);

    // New-doc creation with a hash arg: guard passthrough (doc doesn't exist yet).
    const created = parse(await writeDoc(ctx, { path: "NEW.md", content: "# NEW\n\n## Notes\n", expected_content_hash: "anyhash" }));
    expect(created.ok).toBe(true);
  });

  test("delete_doc: stale → conflict; fresh → ok", async () => {
    const content = "# X\n\n## Notes\n\nbody\n";
    writeFileSync(join(docsDir, "x.md"), content);
    const ctx = localToolContext(docsDir);
    const fresh = hashBody(content);

    const stale = parse(await deleteDoc(ctx, { path: "x.md", expected_content_hash: STALE }));
    expect(stale.error).toBe("stale_content");
    expect(existsSync(join(docsDir, "x.md"))).toBe(true);

    const ok = parse(await deleteDoc(ctx, { path: "x.md", expected_content_hash: fresh }));
    expect(ok.deleted).toBe("x.md");
    expect(existsSync(join(docsDir, "x.md"))).toBe(false);
  });

  test("split_doc: stale source → conflict; fresh → proceeds past guard", async () => {
    const source = "# SRC\n\n## Notes\n\nbody with a paragraph worth extracting\n";
    writeFileSync(join(docsDir, "SRC.md"), source);
    const ctx = localToolContext(docsDir);
    const fresh = hashBody(source);

    const stale = parse(await splitDoc(ctx, {
      source_path: "SRC.md",
      rewrite_source_content: "# SRC\n\n## Notes\n\nsee [[EXTRACT]]\n",
      extracts: [{ path: "EXTRACT.md", content: "# EXTRACT\n\n## Notes\n\nbody\n" }],
      expected_content_hash: STALE,
    }));
    expect(stale.error).toBe("stale_content");
    // Nothing written.
    expect(existsSync(join(docsDir, "EXTRACT.md"))).toBe(false);
    expect(readFileSync(join(docsDir, "SRC.md"), "utf8")).toBe(source);

    // Fresh hash: guard passes. (The split itself may still fail on
    // other pre-flight checks; we only assert the guard didn't fire.)
    const fresh_call = parse(await splitDoc(ctx, {
      source_path: "SRC.md",
      rewrite_source_content: "# SRC\n\n## Notes\n\nsee [[EXTRACT]]\n",
      extracts: [{ path: "EXTRACT.md", content: "# EXTRACT\n\n## Notes\n\nbody\n" }],
      expected_content_hash: fresh,
    }));
    expect(fresh_call.error).not.toBe("stale_content");
  });
});
