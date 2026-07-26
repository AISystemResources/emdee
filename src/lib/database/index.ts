// SPRINT-139: factory + re-exports for the VaultDatabase abstraction.
//
// Cloud mode → SupabasePostgresDatabase wrapping the admin client.
// Local mode has no persistent metadata layer today (indexer parses on
// every read), so no local database impl is needed for Phase 1. Phase 2
// (SIG-032) adds a SqliteDatabase for offline / self-host use.

import { adminClient } from "../supabase/admin";
import { SupabasePostgresDatabase } from "./supabase-postgres";
import type { VaultDatabase } from "./types";

export type { VaultDatabase, VaultFileRow, EdgeRow, EdgeFilter, ListFilesOptions, SummaryDriftOptions } from "./types";
export { SupabasePostgresDatabase } from "./supabase-postgres";

/**
 * Default cloud-mode database instance — wraps the shared admin client.
 * Callers should prefer this over instantiating SupabasePostgresDatabase
 * directly so future swaps happen in one place.
 */
export function cloudDatabase(): VaultDatabase {
  return new SupabasePostgresDatabase(adminClient());
}
