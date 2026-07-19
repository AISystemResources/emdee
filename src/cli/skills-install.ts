// SPRINT-094: install the EMDEE skills bundle into a Claude Code skills dir.
//
// Copies every .md file from the installed package's skills/ folder into
// the target directory (default ~/.claude/skills/). Idempotent — overwrites
// existing files. Users re-run after upgrading the package to get the
// latest skill content.

import { readdir, mkdir, copyFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const DEFAULT_TARGET = path.join(os.homedir(), ".claude", "skills");
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKILLS_SRC = path.join(PKG_ROOT, "skills");

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      dir: { type: "string" },
    },
    strict: true,
  });

  const target = values.dir ? path.resolve(values.dir) : DEFAULT_TARGET;
  await mkdir(target, { recursive: true });

  let files: string[];
  try {
    files = (await readdir(SKILLS_SRC)).filter((f) => f.endsWith(".md"));
  } catch {
    process.stderr.write(`emdee skills install: skills/ folder not found at ${SKILLS_SRC}. Reinstall the package.\n`);
    process.exit(1);
  }

  if (files.length === 0) {
    process.stderr.write(`emdee skills install: no .md files in ${SKILLS_SRC}.\n`);
    process.exit(1);
  }

  for (const f of files) {
    await copyFile(path.join(SKILLS_SRC, f), path.join(target, f));
    process.stdout.write(`  ${f}\n`);
  }
  process.stdout.write(`\nInstalled ${files.length} skills to ${target}.\n`);
  process.stdout.write("Restart Claude Code (or reload skills) to pick them up.\n");
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
