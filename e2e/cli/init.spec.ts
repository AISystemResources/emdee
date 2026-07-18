// SPRINT-093: emdee init streamlined to match cloud seed behaviour.
//
// Asserts:
//  1. `emdee init --nickname X` writes exactly one file (owner node).
//  2. `emdee list` reflects the 6-node minimum vault (owner + 5 virtual system nodes).
//  3. `get_doc` returns virtual system-node content when the file doesn't exist on disk.
//  4. `emdee init` refuses non-TTY invocations without --nickname.
//  5. The duplicated `normalizeOwnerTitle` in `bin/emdee.js` matches the
//     canonical one in `src/lib/owner/identity.ts` for a spread of inputs
//     (drift guard).

import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { normalizeOwnerTitle } from "@/src/lib/owner/identity";
import { getDoc } from "@/src/lib/mcp/tools/get_doc";
import { listDocs } from "@/src/lib/mcp/tools/list_docs";
import type { ToolContext } from "@/src/lib/mcp/tools/types";

const exec = promisify(execFile);
const BIN = path.resolve(process.cwd(), "bin/emdee.js");

interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
}
function parseJson(raw: unknown): unknown {
  const r = raw as ToolCallResult;
  expect(r.content?.[0]?.type).toBe("text");
  return JSON.parse(r.content[0].text);
}

test.describe("emdee init (SPRINT-093)", () => {
  let dir: string;

  test.beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "emdee-init-"));
  });

  test.afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("--nickname writes exactly one file (owner node) with the canonical scaffold", async () => {
    const { stdout } = await exec("node", [BIN, "init", "--nickname", "Testy McTestface"], { cwd: dir });
    expect(stdout).toContain("Created docs/TESTY-MCTESTFACE.md");

    const files = await readdir(path.join(dir, "docs"));
    expect(files.sort()).toEqual(["TESTY-MCTESTFACE.md"]);

    const body = await readFile(path.join(dir, "docs", "TESTY-MCTESTFACE.md"), "utf8");
    expect(body).toMatch(/^# TESTY-MCTESTFACE\n/);
    expect(body).toContain("## Child of\n\n* [[EMDEE]]");
    expect(body).toContain("## Parent of");
    expect(body).toContain("## Associated with");
    expect(body).toContain("## Notes");
  });

  test("list surfaces the 5 virtual system nodes plus the owner", async () => {
    await exec("node", [BIN, "init", "--nickname", "Testy"], { cwd: dir });
    const ctx: ToolContext = { mode: "local", docsDir: path.join(dir, "docs") };
    const raw = await listDocs(ctx, {});
    const docs = parseJson(raw) as Array<{ path: string; title: string }>;
    const paths = docs.map((d) => d.path).sort();
    expect(paths).toEqual(["EMDEE.md", "GRAVEYARD.md", "IMAGES.md", "SHARED.md", "TESTY.md", "VAULT.md"]);
  });

  test("get_doc returns virtual VAULT content when no VAULT.md exists on disk", async () => {
    await exec("node", [BIN, "init", "--nickname", "Testy"], { cwd: dir });
    const ctx: ToolContext = { mode: "local", docsDir: path.join(dir, "docs") };
    const raw = await getDoc(ctx, { path: "VAULT.md", full: true });
    const parsed = parseJson(raw) as { content?: string; summary?: string };
    expect(parsed.content).toContain("# VAULT");
    expect(parsed.content).toContain("[[EMDEE]]");
  });

  test("refuses non-TTY invocation without --nickname", async () => {
    // execFile runs without a TTY by default, so this hits the isTTY=false branch.
    await expect(
      exec("node", [BIN, "init"], { cwd: dir }),
    ).rejects.toMatchObject({ code: 1 });
  });

  test("nickname of only non-ASCII normalises to OWNER and is refused", async () => {
    await expect(
      exec("node", [BIN, "init", "--nickname", "———"], { cwd: dir }),
    ).rejects.toMatchObject({ code: 1 });
  });

  test("idempotent: re-run doesn't overwrite the owner node", async () => {
    await exec("node", [BIN, "init", "--nickname", "Testy"], { cwd: dir });
    const originalBody = await readFile(path.join(dir, "docs", "TESTY.md"), "utf8");
    const { stdout } = await exec("node", [BIN, "init", "--nickname", "Testy"], { cwd: dir });
    expect(stdout).toContain("Already initialised at docs/TESTY.md");
    const afterBody = await readFile(path.join(dir, "docs", "TESTY.md"), "utf8");
    expect(afterBody).toBe(originalBody);
  });

  // Drift guard: the CLI duplicates normalizeOwnerTitle for tarball simplicity.
  // If the two copies diverge we lose local ↔ cloud consistency silently.
  // Instead of unit-testing the copy, we drive the CLI end-to-end for a few
  // inputs and assert the resulting filename matches the canonical function.
  const cases = [
    { nick: "Edmund Lin", expect: "EDMUND-LIN" },
    { nick: "elz.work22", expect: "ELZ-WORK22" },
    { nick: "junior_lin", expect: "JUNIOR-LIN" },
    { nick: "  Testy McTestface  ", expect: "TESTY-MCTESTFACE" },
  ];
  for (const { nick, expect: expected } of cases) {
    test(`normalizeOwnerTitle drift guard: "${nick}" → ${expected}`, async () => {
      expect(normalizeOwnerTitle(nick)).toBe(expected);
      const { stdout } = await exec("node", [BIN, "init", "--nickname", nick], { cwd: dir });
      expect(stdout).toContain(`Created docs/${expected}.md`);
    });
  }
});
