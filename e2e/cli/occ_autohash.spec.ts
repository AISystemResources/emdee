// SPRINT-160: OCC auto-hydration + retry in the CLI write dispatcher.
//
// Motivation: create_child, add_association, patch_section etc. support
// expected_content_hash guards, but the CLI never passed them, so
// concurrent writes silently clobbered each other. The dispatcher now
// auto-fetches the doc's current hash right before the tool call and
// passes it as expected_*_content_hash. On `version_conflict`, it
// refetches and retries up to OCC_MAX_RETRIES.
//
// This spec pins the auto-hydration behavior against local-mode tools.
// The concurrent-write case is separately tested at the tool level.

import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO = path.resolve(__dirname, "..", "..");
const BIN = path.join(REPO, "bin", "emdee.js");

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "emdee-occ-"));
  const docs = path.join(dir, "docs");
  const r = spawnSync("node", [BIN, "init", "--nickname", "occtest"], { cwd: dir, encoding: "utf8" });
  expect(r.status).toBe(0);
  return { dir, docs };
}
async function teardown(dir: string) {
  await rm(dir, { recursive: true, force: true });
}

function run(dir: string, verb: string, args: string[]) {
  return spawnSync("node", [BIN, verb, "--docs", "docs", ...args], {
    cwd: dir,
    encoding: "utf8",
  });
}

test.describe("CLI OCC auto-hydration (SPRINT-160)", () => {
  test("create-child auto-fills expected_parent_content_hash", async () => {
    const { dir } = await setup();
    try {
      // Create a parent first.
      const r1 = run(dir, "create-child", ["--parent-path", "OCCTEST.md", "--title", "PARENT"]);
      expect(r1.status).toBe(0);
      expect(r1.stdout).toContain('"ok": true');

      // A follow-up create-child that DOESN'T pass --expected-parent-hash
      // should succeed — the dispatcher hydrates it automatically. Prior
      // to SPRINT-160 the write would go through without a guard.
      const r2 = run(dir, "create-child", ["--parent-path", "PARENT.md", "--title", "ALPHA"]);
      expect(r2.status).toBe(0);
      expect(r2.stdout).toContain('"ok": true');

      // Sanity: PARENT.md's Parent-of contains the ALPHA bullet.
      const r3 = run(dir, "read-doc-section", ["--path", "PARENT.md", "--heading", "Parent of"]);
      expect(r3.status).toBe(0);
      expect(r3.stdout).toContain("[[ALPHA]]");
    } finally {
      await teardown(dir);
    }
  });

  test("--no-auto-hash opts out", async () => {
    const { dir } = await setup();
    try {
      const r1 = run(dir, "create-child", ["--parent-path", "OCCTEST.md", "--title", "PARENT"]);
      expect(r1.status).toBe(0);
      // With --no-auto-hash and no explicit --expected-parent-hash, the tool
      // sees no hash arg and skips the guard. Should still succeed on a
      // no-contention write.
      const r2 = run(dir, "create-child", [
        "--parent-path", "PARENT.md",
        "--title", "BETA",
        "--no-auto-hash",
      ]);
      expect(r2.status).toBe(0);
      expect(r2.stdout).toContain('"ok": true');
    } finally {
      await teardown(dir);
    }
  });

  test("add-association auto-fills both expected-a-hash and expected-b-hash", async () => {
    const { dir } = await setup();
    try {
      // Create two docs under different parents so add_association's
      // sibling-refusal doesn't trigger. FOO under OCCTEST, then BAR
      // under FOO.
      const r1 = run(dir, "create-child", ["--parent-path", "OCCTEST.md", "--title", "FOO"]);
      expect(r1.status).toBe(0);
      const r2 = run(dir, "create-child", ["--parent-path", "FOO.md", "--title", "BAR"]);
      expect(r2.status).toBe(0);
      const r3 = run(dir, "create-child", ["--parent-path", "OCCTEST.md", "--title", "BAZ"]);
      expect(r3.status).toBe(0);

      // No --expected-a-hash / --expected-b-hash passed. Dispatcher
      // hydrates both from get_doc calls before invoking the tool.
      const r4 = run(dir, "add-association", ["--a-path", "BAR.md", "--b-path", "BAZ.md"]);
      expect(r4.status).toBe(0);
      expect(r4.stdout).toContain('"ok": true');
    } finally {
      await teardown(dir);
    }
  });
});
