// SPRINT-139 + SPRINT-140: factory + re-exports for the VaultDatabase
// abstraction. Cloud mode → SupabasePostgresDatabase. Local mode →
// SqliteDatabase (better-sqlite3, in-process).
//
// Both factories lazy-require their impl so pure-local runtimes never
// load the Supabase client and cloud runtimes never load better-sqlite3's
// native binding. Preserves the SIG-032 zero-cloud-deps guarantee for
// local users.

import { createRequire } from "node:module";
import type { VaultDatabase } from "./types";

export type { VaultDatabase, VaultFileRow, EdgeRow, EdgeFilter, ListFilesOptions, SummaryDriftOptions } from "./types";

// ESM-safe require. Two backends stay lazily loaded so a pure-local
// runtime never triggers the Supabase module tree, and a pure-cloud
// runtime never touches better-sqlite3's native binding.
const req = createRequire(import.meta.url);

// SPRINT-140F: when this file runs from source (tsx), sibling
// `./sqlite` and `./supabase-postgres` resolve fine. When bundled into
// dist/cli/*.js by esbuild, the siblings don't exist next to the
// bundle. Fall back to the parallel `dist/lib/database/` compilation
// of the same file, which build-cli.mjs now emits.
function requireBackend<T>(name: "sqlite" | "supabase-postgres"): T {
  try {
    return req(`./${name}`) as T;
  } catch {
    return req(`../lib/database/${name}.js`) as T;
  }
}

/** Default cloud-mode database instance — wraps the shared admin client. */
export function cloudDatabase(): VaultDatabase {
  const { SupabasePostgresDatabase } = requireBackend<typeof import("./supabase-postgres")>("supabase-postgres");
  const { adminClient } = req("../supabase/admin") as typeof import("../supabase/admin");
  return new SupabasePostgresDatabase(adminClient());
}

/** Local-mode database. Default path is `<docsDir>/.emdee/vault.db`. */
export function localDatabase(dbPath: string): VaultDatabase {
  const { SqliteDatabase } = requireBackend<typeof import("./sqlite")>("sqlite");
  return new SqliteDatabase(dbPath);
}
