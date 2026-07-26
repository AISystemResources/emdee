// SPRINT-139 + SPRINT-140: factory + re-exports for the VaultDatabase
// abstraction. Cloud mode → SupabasePostgresDatabase. Local mode →
// SqliteDatabase (better-sqlite3, in-process).

import type { VaultDatabase } from "./types";
import { SqliteDatabase } from "./sqlite";
import { SupabasePostgresDatabase } from "./supabase-postgres";
import { adminClient } from "../supabase/admin";

export type { VaultDatabase, VaultFileRow, EdgeRow, EdgeFilter, ListFilesOptions, SummaryDriftOptions } from "./types";

// SPRINT-140F: static imports for both backends. Prior versions used a
// dynamic-require dispatch to keep each runtime from loading the other
// backend's deps. That broke webpack (context modules pulled sibling
// files like sqlite-schema.sql) and broke esbuild's dist bundle
// (dynamic strings don't get followed at bundle time). Static imports
// work in both build systems. better-sqlite3 stays external in the CLI
// dist and is a regular dependency in cloud — Vercel has linux-x64
// prebuilds so it loads fine even in serverless runtimes that never
// construct a SqliteDatabase.

/** Default cloud-mode database instance — wraps the shared admin client. */
export function cloudDatabase(): VaultDatabase {
  return new SupabasePostgresDatabase(adminClient());
}

/** Local-mode database. Default path is `<docsDir>/.emdee/vault.db`. */
export function localDatabase(dbPath: string): VaultDatabase {
  return new SqliteDatabase(dbPath);
}
