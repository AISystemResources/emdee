// SPRINT-140F: HARD RULE 11 regression spec for the CLI dist bundle.
//
// 0.5.0 and 0.5.1 shipped a broken CLI bundle: `dist/cli/write-commands.js`
// referenced `./sqlite` via createRequire, but esbuild couldn't statically
// follow the dynamic string and the sibling file never made it to dist.
// Every local-mode verb (lint-orphans, reconcile, any local vault write)
// blew up with `Cannot find module './sqlite'` for anyone who installed
// via `npm i -g @aisystemresources/emdee`.
//
// Two things to pin:
// 1. Schema inlining — SqliteDatabase constructs without needing the
//    sibling .sql file (survives bundling).
// 2. Backend dispatch — localDatabase() returns a working instance from
//    both source (tsx) and, via requireBackend()'s fallback, from the
//    dist/lib/database/ location.

import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { localDatabase } from "@/src/lib/database";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function setup() {
  return await mkdtemp(path.join(tmpdir(), "emdee-localdb-"));
}
async function teardown(dir: string) {
  await rm(dir, { recursive: true, force: true });
}

test.describe("SqliteDatabase bundling (SPRINT-140F)", () => {
  test("localDatabase constructs and applies inlined schema", async () => {
    const docsDir = await setup();
    try {
      const dbPath = path.join(docsDir, ".emdee", "vault.db");
      const db = localDatabase(dbPath);

      // Constructor applies SQLITE_SCHEMA — if the schema were still
      // read via fs sibling lookup, this would throw before we got here.
      expect(db).toBeDefined();
      expect(existsSync(dbPath)).toBe(true);

      // Prove the schema actually landed: putFile + listFiles round-trip.
      await db.putFile("local", "A.md", "# A\n\n> First.\n");
      await db.putFile("local", "B.md", "# B\n\n> Second.\n");

      const rows = await db.listFiles("local");
      expect(rows).toHaveLength(2);
      const paths = rows.map((r) => r.file_path).sort();
      expect(paths).toEqual(["A.md", "B.md"]);

      // Title backfill (SPRINT-143) — persisted title column populated
      // from H1 at putFile time.
      const a = rows.find((r) => r.file_path === "A.md");
      expect(a?.title).toBe("A");
    } finally {
      await teardown(docsDir);
    }
  });

  test("bundled dist/cli/write-commands.js inlines the sqlite backend", () => {
    // The 0.5.0/0.5.1 bug was that `createRequire("./sqlite")` in
    // index.ts wasn't followed by esbuild, so the sqlite backend never
    // made it into the CLI bundle. With static imports the backend
    // source shows up directly in the bundle. If someone regresses to
    // a dynamic dispatch, this string check will fail.
    const repoRoot = path.resolve(__dirname, "..", "..");
    const bundlePath = path.join(repoRoot, "dist", "cli", "write-commands.js");
    expect(existsSync(bundlePath)).toBe(true);
    const bundle = readFileSync(bundlePath, "utf8");
    // Look for a distinctive fragment from sqlite-schema.ts, proving
    // the schema (and by extension the SqliteDatabase code path) got
    // bundled in and doesn't rely on a runtime sibling file.
    expect(bundle).toContain("vault_files_fts");
    expect(bundle).toContain("PRAGMA user_version = 2");
  });
});
