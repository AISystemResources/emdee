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
import { existsSync } from "node:fs";
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

  test("bundled dist/lib/database/sqlite.js is importable as fallback target", async () => {
    // If build-cli.mjs stops emitting these entries, requireBackend()'s
    // fallback branch has nothing to require. Rather than dynamically
    // loading the bundle (which would need a running npm pack), we just
    // assert the file exists — the fallback path in index.ts uses a
    // literal require and would fail identically at runtime.
    const repoRoot = path.resolve(__dirname, "..", "..");
    expect(existsSync(path.join(repoRoot, "dist", "lib", "database", "sqlite.js"))).toBe(true);
    expect(existsSync(path.join(repoRoot, "dist", "lib", "database", "supabase-postgres.js"))).toBe(true);
  });
});
