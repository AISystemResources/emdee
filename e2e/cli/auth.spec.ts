// SPRINT-091: auth-command wiring for the CLI.
//
// Full PKCE flow is skipped in CI (would require an actual browser + Clerk
// session). What we DO cover:
//  1. `emdee whoami` with no credentials exits 1 with the "run login" message
//  2. `emdee logout` when nothing is stored says so (idempotent, exit 0)
//  3. `emdee list --remote` without creds fails cleanly
//  4. `emdee login --help` shows the --host flag (proves the command wired up)

import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const BIN = path.resolve(process.cwd(), "bin/emdee.js");

// The auth flow reads/writes ~/.config/emdee/credentials.json — remap HOME to
// a scratch dir per test so we don't touch any real developer credentials.
async function isolatedHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "emdee-home-"));
  await mkdir(path.join(home, ".config", "emdee"), { recursive: true });
  return home;
}

test.describe("emdee auth commands (SPRINT-091)", () => {
  let home: string;

  test.beforeEach(async () => {
    home = await isolatedHome();
  });

  test.afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("whoami without creds exits 1 with the run-login message", async () => {
    await expect(
      exec("node", [BIN, "whoami"], { env: { ...process.env, HOME: home } }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("emdee login"),
    });
  });

  test("logout is idempotent when nothing stored", async () => {
    const { stdout } = await exec("node", [BIN, "logout"], { env: { ...process.env, HOME: home } });
    expect(stdout).toMatch(/Already logged out/);
  });

  test("list --remote without creds fails cleanly", async () => {
    await expect(
      exec("node", [BIN, "list", "--remote"], { env: { ...process.env, HOME: home } }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("emdee login"),
    });
  });

  test("login --help mentions --host flag", async () => {
    const { stdout } = await exec("node", [BIN, "login", "--help"]);
    expect(stdout).toContain("--host");
    expect(stdout).toContain("emdee.tech");
  });

  test("logout after mock creds actually removes them", async () => {
    const credsPath = path.join(home, ".config", "emdee", "credentials.json");
    await writeFile(
      credsPath,
      JSON.stringify({ access_token: "fake", client_id: "fake", host: "https://emdee.tech", saved_at: Date.now() }),
      "utf8",
    );
    const { stdout } = await exec("node", [BIN, "logout"], { env: { ...process.env, HOME: home } });
    expect(stdout).toMatch(/^Logged out/);
    // Second call should be idempotent
    const second = await exec("node", [BIN, "logout"], { env: { ...process.env, HOME: home } });
    expect(second.stdout).toMatch(/Already logged out/);
  });
});
