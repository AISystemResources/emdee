// SPRINT-131: auto-install EMDEE skills into ~/.claude/skills/ on
// `npm install -g`. Users no longer need to remember to run
// `emdee skills-install` separately after each upgrade.
//
// Guards:
// - If dist/cli/skills-install.js isn't present (dev checkout without
//   `npm run build:cli`), skip silently.
// - If EMDEE_SKIP_POSTINSTALL=1 in env, skip (opt-out).
// - Failure of skills-install is logged as warning, NOT an error —
//   we don't want a skills-copy hiccup to make the entire npm install fail.

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillsInstallScript = path.resolve(scriptDir, "..", "dist", "cli", "skills-install.js");

if (process.env.EMDEE_SKIP_POSTINSTALL === "1") {
  console.log("[emdee] skills-install skipped (EMDEE_SKIP_POSTINSTALL=1)");
  process.exit(0);
}

if (!existsSync(skillsInstallScript)) {
  // dist/ not yet built — happens on dev checkouts pre-`npm run build:cli`.
  // Silent skip; user can run `emdee skills-install` manually if wanted.
  process.exit(0);
}

const result = spawnSync("node", [skillsInstallScript], { stdio: "inherit" });
if (result.status !== 0) {
  console.warn("[emdee] skills-install exited non-zero — you can retry manually with `emdee skills-install`");
}
process.exit(0);
