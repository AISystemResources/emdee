// Post-SPRINT-091 parity-gap closers: distill-doc, materialize-subgroup,
// split-doc, get-image. Local-mode e2e.

import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const BIN = path.resolve(process.cwd(), "bin/emdee.js");

test.describe("emdee parity gap closers", () => {
  let dir: string;

  test.beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "emdee-parity-"));
    await mkdir(path.join(dir, "docs"), { recursive: true });
  });

  test.afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("distill-doc returns section boundaries + vault context for a source doc", async () => {
    const src = `# BIG-NOTE\n\n> A doc with several ideas.\n\n## Section A\n\nContent A.\n\n## Section B\n\nContent B.\n`;
    await writeFile(path.join(dir, "docs", "BIG-NOTE.md"), src, "utf8");
    const { stdout } = await exec("node", [
      BIN, "distill-doc", "--path", "BIG-NOTE.md", "-d", "docs", "--json",
    ], { cwd: dir });
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty("source");
    expect(parsed.source).toHaveProperty("sections");
    const sections = parsed.source.sections as Array<{ heading: string }>;
    expect(sections.some((s) => s.heading === "Section A")).toBeTruthy();
    expect(sections.some((s) => s.heading === "Section B")).toBeTruthy();
  });

  test("materialize-subgroup requires source-path and subgroup-heading", async () => {
    // Just prove the arg-validation surface works — no valid source in this dir.
    // SPRINT-127: --json is passed so payload still lands on stdout; exit 1.
    let stdout = "", exitCode = 0;
    try {
      const r = await exec("node", [
        BIN, "materialize-subgroup",
        "--source-path", "MISSING.md",
        "--subgroup-heading", "Some Group",
        "-d", "docs", "--json",
      ], { cwd: dir });
      stdout = r.stdout;
    } catch (err: unknown) {
      const e = err as { stdout?: string; code?: number };
      stdout = e.stdout ?? "";
      exitCode = e.code ?? 1;
    }
    expect(exitCode).toBe(1);
    expect(stdout).toMatch(/error|not.*found|source/i);
  });

  test("split-doc reads extracts from --extracts-file", async () => {
    const src = `# SOURCE\n\n> Source doc.\n\n## Notes\n\nOld content that will be extracted.\n`;
    await writeFile(path.join(dir, "docs", "SOURCE.md"), src, "utf8");
    const extractsPath = path.join(dir, "extracts.json");
    await writeFile(extractsPath, JSON.stringify([
      { path: "EXTRACTED.md", content: "# EXTRACTED\n\n> The extracted concept.\n\n## Child of\n\n* [[SOURCE]]\n\n## Notes\n\nOld content that will be extracted.\n" },
    ]), "utf8");
    const rewritePath = path.join(dir, "rewrite.txt");
    const rewriteContent = `# SOURCE\n\n> Source doc now points at extracted concept.\n\n## Parent of\n\n* [[EXTRACTED]]\n\n## Notes\n\nSee [[EXTRACTED]].\n`;
    await writeFile(rewritePath, rewriteContent, "utf8");
    const { stdout } = await exec("node", [
      BIN, "split-doc",
      "--source-path", "SOURCE.md",
      "--rewrite-source-content", rewriteContent,
      "--extracts-file", extractsPath,
      "-d", "docs", "--json",
    ], { cwd: dir });
    expect(stdout).toMatch(/"ok":\s*true|extracted/);
    // Extract file should now exist.
    const extractedBody = await readFile(path.join(dir, "docs", "EXTRACTED.md"), "utf8");
    expect(extractedBody).toContain("The extracted concept");
  });

  test("get-image errors cleanly when the doc has no image URL", async () => {
    const notImage = `# NOT-IMAGE\n\n> A text doc, no image.\n\n## Notes\n\nJust text.\n`;
    await writeFile(path.join(dir, "docs", "NOT-IMAGE.md"), notImage, "utf8");
    const { stdout } = await exec("node", [
      BIN, "get-image", "--doc-path", "NOT-IMAGE.md",
    ], { cwd: dir, env: { ...process.env, EMDEE_DOCS: path.join(dir, "docs") } });
    expect(stdout).toMatch(/no image URL|error/i);
  });
});
