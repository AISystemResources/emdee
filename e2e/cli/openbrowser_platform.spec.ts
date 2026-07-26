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

  test("win32 → `cmd /c start \"\" <url>` (not bare `start`)", () => {
    const { cmd, args } = browserOpenerArgv(URL, "win32");
    expect(cmd).toBe("cmd");
    // The empty "" is required as start's window-title placeholder.
    // Without it, start treats the first quoted arg as the title and
    // silently swallows the URL.
    expect(args).toEqual(["/c", "start", "", URL]);
    // Explicit anti-regression: never regress to bare `start`.
    expect(cmd).not.toBe("start");
  });

  test("unknown platform falls through to xdg-open", () => {
    // Node's process.platform is typed as NodeJS.Platform; cast for the
    // test-only "future platform" case (e.g. `openbsd`, `sunos`).
    const { cmd } = browserOpenerArgv(URL, "openbsd" as NodeJS.Platform);
    expect(cmd).toBe("xdg-open");
  });
});
