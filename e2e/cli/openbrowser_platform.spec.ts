// SPRINT-160B: HARD RULE 11 regression spec for browserOpenerArgv.
//
// 0.5.3 shipped an `openBrowser` that ran `spawn("start", [url])` on
// Windows and blew up with `spawn start ENOENT` on every Windows user's
// `emdee login`. `start` is a cmd.exe BUILTIN, not a standalone
// executable. Correct incantation is `cmd /c start "" "<url>"`.
//
// This spec pins the platform → argv mapping. If someone regresses
// Windows back to bare `start`, the test fails.

import { expect, test } from "@playwright/test";
import { browserOpenerArgv } from "@/src/cli/auth";

const URL = "https://emdee.tech/oauth/authorize?client_id=abc&state=xyz";

test.describe("browserOpenerArgv (SPRINT-160B)", () => {
  test("darwin → `open <url>`", () => {
    const { cmd, args } = browserOpenerArgv(URL, "darwin");
    expect(cmd).toBe("open");
    expect(args).toEqual([URL]);
  });

  test("linux → `xdg-open <url>`", () => {
    const { cmd, args } = browserOpenerArgv(URL, "linux");
    expect(cmd).toBe("xdg-open");
    expect(args).toEqual([URL]);
  });

  test("win32 → `powershell -NoProfile -Command Start-Process '<url>'` (SPRINT-160C)", () => {
    const { cmd, args } = browserOpenerArgv(URL, "win32");
    expect(cmd).toBe("powershell");
    expect(args[0]).toBe("-NoProfile");
    expect(args[1]).toBe("-Command");
    // Must contain the FULL URL (including & and everything after it).
    // The `cmd /c start` predecessor truncated URLs at the first `&`;
    // this regresses if someone switches back.
    expect(args[2]).toBe(`Start-Process '${URL}'`);
    expect(args[2]).toContain("client_id=");
    expect(args[2]).toContain("&state=xyz");
    // Explicit anti-regression: never regress to bare `start` or `cmd start`.
    expect(cmd).not.toBe("start");
    expect(cmd).not.toBe("cmd");
  });

  test("win32 → embedded single quotes in URL are escaped for PowerShell", () => {
    const urlWithQuote = "https://emdee.tech/oauth/authorize?state=abc'def";
    const { args } = browserOpenerArgv(urlWithQuote, "win32");
    // PowerShell escapes ' inside single-quoted strings as ''.
    expect(args[2]).toBe("Start-Process 'https://emdee.tech/oauth/authorize?state=abc''def'");
  });

  test("unknown platform falls through to xdg-open", () => {
    // Node's process.platform is typed as NodeJS.Platform; cast for the
    // test-only "future platform" case (e.g. `openbsd`, `sunos`).
    const { cmd } = browserOpenerArgv(URL, "openbsd" as NodeJS.Platform);
    expect(cmd).toBe("xdg-open");
  });
});
