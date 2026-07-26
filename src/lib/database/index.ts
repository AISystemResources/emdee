// SPRINT-139 + SPRINT-140: factory + re-exports for the VaultDatabase
// abstraction. Cloud mode → SupabasePostgresDatabase. Local mode →
// SqliteDatabase (better-sqlite3, in-process).
//
// Both factories lazy-require their impl so pure-local runtimes never
// load the Supabase client and cloud runtimes never load better-sqlite3's
// native binding. Preserves the SIG-032 zero-cloud-deps guarantee for
// local users.

import type { VaultDatabase } from "./types";
import { SqliteDatabase } from "./sqlite";
import { SupabasePostgresDatabase } from "./supabase-postgres";
import { adminClient } from "../supabase/admin";

export type { VaultDatabase, VaultFileRow, EdgeRow, EdgeFilter, ListFilesOptions, SummaryDriftOptions } from "./types";

// SPRINT-140F: static imports across both backends. Prior versions used
// createRequire()-based lazy dispatch to keep each runtime from loading
// the other backend's deps. That broke webpack (which can't resolve the
// dynamic string and creates a context module pulling in sibling files
// like sqlite-schema.sql) and broke esbuild's dist bundle (dynamic
// strings don't get followed at bundle time). Static imports work in
// both build systems. better-sqlite3 stays external in the CLI dist and
// is a regular dependency in cloud — Vercel has linux-x64 prebuilds so
// it loads fine even in serverless runtimes that never construct a
// SqliteDatabase.

/** Default cloud-mode database instance — wraps the shared admin client. */
export function cloudDatabase(): VaultDatabase {
  return new SupabasePostgresDatabase(adminClient());
}

/** Local-mode database. Default path is `<docsDir>/.emdee/vault.db`. */
export function localDatabase(dbPath: string): VaultDatabase {
  return new SqliteDatabase(dbPath);
}
