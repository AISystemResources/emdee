#!/usr/bin/env node
// SPRINT-090: package hygiene gate.
//
// Runs `npm pack --dry-run --json` and asserts:
//   1. Every packed file matches one of a known prefix (allowlist).
//   2. No env / secret / app-dir files sneak in via a stray `files` glob.
//   3. Tarball size is under a sanity cap.
//
// Wired into CI's ci-package job; a failing run means the tarball would
// ship the wrong contents. Cheap safety net against surprise 100MB
// publishes or, worse, an accidental `.env` leak.

import { execFileSync } from "node:child_process";

const ALLOWED_PREFIXES = [
  "package.json",
  "README.md",
  "bin/",
  "src/cli/",
  "src/core/",
  "src/lib/cache/",
  "src/lib/mcp/",
  "src/lib/owner/",
  "src/lib/storage/",
  "src/lib/supabase/",
  "src/lib/system-nodes.ts",
  "src/lib/trash/",
  "src/mcp/",
  "skills/",
  "templates/",
];

// Explicit denylist for the paranoid case where a `files` entry accidentally
// widens too much. If any of these show up in the pack, hard-fail.
const DENIED_PATTERNS = [
  /^\.env/,
  /credentials/i,
  /secret/i,
  /^app\//,
  /^docs\//,
  /^e2e\//,
  /^supabase\//,
  /\.local\./,
];

const SIZE_CAP_BYTES = 5 * 1024 * 1024; // 5 MB

const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" });
const packs = JSON.parse(raw);
if (!Array.isArray(packs) || packs.length !== 1) {
  console.error("verify-package: expected exactly one pack entry, got", packs);
  process.exit(1);
}
const pack = packs[0];
const files = (pack.files ?? []).map((f) => f.path);

if (files.length === 0) {
  console.error("verify-package: pack produced zero files. `files` allowlist is probably empty.");
  process.exit(1);
}

const bad = [];
for (const p of files) {
  const allowed = ALLOWED_PREFIXES.some((pfx) => p === pfx || p.startsWith(pfx));
  const denied = DENIED_PATTERNS.some((re) => re.test(p));
  if (denied) bad.push(`DENIED  ${p}`);
  else if (!allowed) bad.push(`UNKNOWN ${p} (not in allowlist)`);
}

if (bad.length > 0) {
  console.error("verify-package: forbidden files in tarball:");
  for (const line of bad) console.error("  " + line);
  console.error(`\nAllowlist prefixes: ${ALLOWED_PREFIXES.join(", ")}`);
  process.exit(1);
}

if (pack.size > SIZE_CAP_BYTES) {
  console.error(
    `verify-package: tarball size ${pack.size} > ${SIZE_CAP_BYTES}. ` +
      `Check for accidentally-included large files.`
  );
  process.exit(1);
}

console.log(
  `verify-package: OK — ${files.length} files, ${pack.size} bytes (unpacked: ${pack.unpackedSize}).`
);
