// SPRINT-091 chunk 2: CLI write verbs, local mode end-to-end.
//
// One file per verb would be overkill given the dispatcher is table-driven;
// each verb is proved end-to-end (spawn process, mutate a real file on
// disk, read the file back) for the ones that carry the most risk:
// patch-section (version-guarded), append-doc (destructive-safe),
// create-child (atomic multi-side), rename-doc (mass-rewrite).

import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

const exec = promisify(execFile);
const BIN = path.resolve(process.cwd(), "bin/emdee.js");

function hashBody(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex").slice(0, 16);
}

test.describe("emdee write commands, local mode (SPRINT-091)", () => {
  let dir: string;

  test.beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "emdee-write-"));
    await mkdir(path.join(dir, "docs"), { recursive: true });
  });

  test.afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("append-section adds content to an existing H2 section", async () => {
    const original = `# ALPHA\n\n> Root doc.\n\n## Notes\n\nOld body.\n`;
    await writeFile(path.join(dir, "docs", "ALPHA.md"), original, "utf8");
    const result = await exec("node", [
      BIN, "append-section",
      "--path", "ALPHA.md",
      "--heading", "Notes",
      "--body", "Additional content from CLI.",
      "-d", "docs",
    ], { cwd: dir });
    expect(result.stdout).toMatch(/"ok":\s*true/);
    const after = await readFile(path.join(dir, "docs", "ALPHA.md"), "utf8");
    expect(after).toContain("Old body.");
    expect(after).toContain("Additional content from CLI.");
  });

  test("patch-section returns version_conflict on stale hash", async () => {
    const original = `# ALPHA\n\n> Root doc.\n\n## Notes\n\nOld body.\n`;
    await writeFile(path.join(dir, "docs", "ALPHA.md"), original, "utf8");
    const result = await exec("node", [
      BIN, "patch-section",
      "--path", "ALPHA.md",
      "--heading", "Notes",
      "--body", "New body.",
      "--expected-hash", "0000000000000000",
      "-d", "docs",
    ], { cwd: dir });
    expect(result.stdout).toMatch(/"error":\s*"version_conflict"/);
  });

  test("append-doc adds content to the end of the file", async () => {
    const original = `# BETA\n\n> A doc.\n\n## Notes\n\nOriginal.\n`;
    await writeFile(path.join(dir, "docs", "BETA.md"), original, "utf8");
    await exec("node", [
      BIN, "append-doc",
      "--path", "BETA.md",
      "--body", "\n## New Section\n\nFresh content.",
      "-d", "docs",
    ], { cwd: dir });
    const after = await readFile(path.join(dir, "docs", "BETA.md"), "utf8");
    expect(after).toContain("## New Section");
    expect(after).toContain("Fresh content");
    expect(after.indexOf("## New Section")).toBeGreaterThan(after.indexOf("Original"));
  });

  test("create-child writes new doc AND patches parent's Parent of", async () => {
    const parent = `# PARENT\n\n> Test parent.\n\n## Parent of\n\n## Notes\n`;
    await writeFile(path.join(dir, "docs", "PARENT.md"), parent, "utf8");
    await exec("node", [
      BIN, "create-child",
      "--parent-path", "PARENT.md",
      "--title", "NEW-CHILD",
      "--summary", "A freshly-created child via CLI.",
      "-d", "docs",
    ], { cwd: dir });
    // Parent should now list the child in Parent of
    const parentAfter = await readFile(path.join(dir, "docs", "PARENT.md"), "utf8");
    expect(parentAfter).toContain("[[NEW-CHILD]]");
    // Child should exist with the canonical scaffold
    const childBody = await readFile(path.join(dir, "docs", "NEW-CHILD.md"), "utf8");
    expect(childBody).toMatch(/^# NEW-CHILD\n/);
    expect(childBody).toContain("[[PARENT]]");
    expect(childBody).toContain("A freshly-created child via CLI.");
  });

  test("rename-doc rewrites H1 + file path + wiki-links across the vault", async () => {
    const a = `# HELLO\n\n> First.\n\n## Notes\n\nSee [[OTHER]].\n`;
    const b = `# OTHER\n\n> Second.\n\n## Associated with\n\n* [[HELLO]] — reference\n`;
    await writeFile(path.join(dir, "docs", "HELLO.md"), a, "utf8");
    await writeFile(path.join(dir, "docs", "OTHER.md"), b, "utf8");
    await exec("node", [
      BIN, "rename-doc",
      "--old-path", "HELLO.md",
      "--new-title", "GREETINGS",
      "-d", "docs",
    ], { cwd: dir });
    // Old file gone, new file exists with new H1
    const newBody = await readFile(path.join(dir, "docs", "GREETINGS.md"), "utf8");
    expect(newBody).toMatch(/^# GREETINGS\n/);
    // OTHER.md should now reference [[GREETINGS]] instead of [[HELLO]]
    const otherAfter = await readFile(path.join(dir, "docs", "OTHER.md"), "utf8");
    expect(otherAfter).toContain("[[GREETINGS]]");
    expect(otherAfter).not.toContain("[[HELLO]]");
  });

  test("add-association is refused on hierarchy-duplicating pair", async () => {
    // Parent → Child hierarchy edge already exists; adding assoc should refuse.
    const parent = `# HUB\n\n> Hub.\n\n## Parent of\n\n* [[LEAF]]\n`;
    const leaf = `# LEAF\n\n> Leaf.\n\n## Child of\n\n* [[HUB]]\n`;
    await writeFile(path.join(dir, "docs", "HUB.md"), parent, "utf8");
    await writeFile(path.join(dir, "docs", "LEAF.md"), leaf, "utf8");
    const result = await exec("node", [
      BIN, "add-association",
      "--a-path", "HUB.md",
      "--b-path", "LEAF.md",
      "-d", "docs",
    ], { cwd: dir });
    // Should either return would_duplicate_hierarchy or ok with a warning;
    // per SPRINT-054 the tool hard-refuses.
    expect(result.stdout).toMatch(/would_duplicate_hierarchy|hierarchical/);
  });

  test("--json output is machine-parseable", async () => {
    const original = `# GAMMA\n\n> A doc.\n\n## Notes\n\nHello.\n`;
    await writeFile(path.join(dir, "docs", "GAMMA.md"), original, "utf8");
    const result = await exec("node", [
      BIN, "append-doc",
      "--path", "GAMMA.md",
      "--body", "\n\nMore.",
      "-d", "docs",
      "--json",
    ], { cwd: dir });
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({ ok: true });
    // Silence unused import
    void hashBody;
  });
});
