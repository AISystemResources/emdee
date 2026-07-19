// SPRINT-094: skills-install copies the 4 packaged skills into a target dir.

import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const BIN = path.resolve(process.cwd(), "bin/emdee.js");

test.describe("emdee skills-install (SPRINT-094)", () => {
  let dir: string;

  test.beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "emdee-skills-"));
  });

  test.afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("--dir copies every .md from skills/ into the target", async () => {
    const target = path.join(dir, "skills-out");
    const { stdout } = await exec("node", [BIN, "skills-install", "--dir", target]);
    expect(stdout).toContain("emdee-conventions.md");
    expect(stdout).toContain("Installed 4 skills");
    const files = (await readdir(target)).sort();
    expect(files).toEqual([
      "emdee-conventions.md",
      "emdee-describe-image.md",
      "emdee-onboarder.md",
      "emdee-summariser.md",
    ]);
  });

  test("copied conventions skill has the frontmatter + H1", async () => {
    const target = path.join(dir, "s");
    await exec("node", [BIN, "skills-install", "--dir", target]);
    const body = await readFile(path.join(target, "emdee-conventions.md"), "utf8");
    expect(body).toMatch(/^---\nname: emdee-conventions/);
    expect(body).toContain("# EMDEE conventions");
  });

  test("re-run is idempotent (overwrites)", async () => {
    const target = path.join(dir, "s");
    await exec("node", [BIN, "skills-install", "--dir", target]);
    const first = await readFile(path.join(target, "emdee-conventions.md"), "utf8");
    await exec("node", [BIN, "skills-install", "--dir", target]);
    const second = await readFile(path.join(target, "emdee-conventions.md"), "utf8");
    expect(second).toBe(first);
  });
});
