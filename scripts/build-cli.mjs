// SPRINT-129: bundle CLI entry points to plain JS via esbuild so the
// runtime skips tsx cold-start entirely. Measured: 3.1s → 79ms (~40×)
// on `emdee <write-verb>` invocations.
//
// Bundles four TS entry points into dist/cli/. bin/emdee.js checks for
// dist/ presence and prefers node over `npx tsx` when available.
//
// Externals: keep native + heavy deps external. esbuild bundles the
// rest into one file per entry point.

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const entries = [
  { in: "src/cli/write-commands.ts", out: "dist/cli/write-commands.js" },
  { in: "src/cli/read-commands.ts", out: "dist/cli/read-commands.js" },
  { in: "src/cli/auth-commands.ts", out: "dist/cli/auth-commands.js" },
  { in: "src/cli/skills-install.ts", out: "dist/cli/skills-install.js" },
  { in: "src/mcp/server.ts", out: "dist/mcp/server.js" },
];

const commonOptions = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: [
    "@modelcontextprotocol/sdk",
    "@supabase/supabase-js",
    "@supabase/ssr",
    "@clerk/nextjs",
    "puppeteer-core",
    "@sparticuz/chromium",
    "jszip",
    "marked",
    "commander",
    "tsx",
  ],
  logLevel: "info",
};

for (const e of entries) {
  await build({
    ...commonOptions,
    entryPoints: [path.join(root, e.in)],
    outfile: path.join(root, e.out),
  });
}

console.log(`\nBuilt ${entries.length} CLI entry points to dist/`);
