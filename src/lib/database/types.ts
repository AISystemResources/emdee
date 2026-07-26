// SPRINT-139 (SIG-032 Phase 1): VaultDatabase interface.
//
// Abstracts every runtime interaction with the persisted metadata layer
// (`vault_files` cache + `doc_edges` materialized graph) so tools stop
// calling Supabase directly. Same pattern as VaultStorage (already
// abstracts the doc-bytes layer): interface here, concrete impls under
// sibling folders (`supabase-postgres/`, future `sqlite/`).
//
// Design: namespace as parameter, not baked into instance. Matches
// VaultStorage's stateless-instance convention and keeps admin/migration
// tools that span namespaces simple.

// Doc cache row (from `vault_files` table).
export interface VaultFileRow {
  namespace: string;
  file_path: string;
  content: string;
  /**
   * H1 title. Populated by a Postgres GENERATED column on cloud; the
   * SQLite backend derives it in-app at putFile time. NULL when the
   * doc has no `^# ` heading — callers should fall back to the
   * filename slug in that case. See SPRINT-143.
   */
  title?: string | null;
  updated_at?: string;
  summary_hash?: string | null;
  content_hash_at_summary_write?: string | null;
}

// Materialized edge row (from `doc_edges` table).
export interface EdgeRow {
  namespace: string;
  from_path: string;
  to_path: string;
  kind: "hierarchy" | "assoc";
  label: string | null;
  position: number;
}

export interface EdgeFilter {
  from_path?: string;
  to_path?: string;
  kind?: "hierarchy" | "assoc";
}

export interface ListFilesOptions {
  prefix?: string;
  limit?: number;
  offset?: number;
  /** SPRINT-119 requires ORDER BY file_path for pagination stability. */
  order?: "file_path_asc";
  /** Comma-separated field names to retrieve. Default: all fields. */
  select?: string;
}

export interface SummaryDriftOptions {
  prefix?: string;
  limit?: number;
  offset?: number;
}

/**
 * Every runtime interaction with the persisted metadata layer.
 * Namespace is passed per call — the interface stays stateless so admin
 * tools spanning namespaces work without contortions.
 */
export interface VaultDatabase {
  // ---------- vault_files (doc cache) ----------
  getFile(ns: string, path: string): Promise<VaultFileRow | null>;
  putFile(ns: string, path: string, content: string, meta?: {
    summary_hash?: string;
    content_hash_at_summary_write?: string;
  }): Promise<void>;
  deleteFile(ns: string, path: string): Promise<void>;
  listFiles(ns: string, opts?: ListFilesOptions): Promise<VaultFileRow[]>;
  /** Full-text search (SPRINT-122b). Only implemented on backends supporting FTS. */
  searchFiles(ns: string, query: string, limit: number, excludePath?: string): Promise<VaultFileRow[]>;
  /** Drift candidates for summariser (SPRINT-081). */
  getSummaryDrift(ns: string, opts?: SummaryDriftOptions): Promise<VaultFileRow[]>;

  // ---------- doc_edges (materialized graph) ----------
  getEdges(ns: string, filter?: EdgeFilter): Promise<EdgeRow[]>;
  /** Atomic delete-then-insert for a single doc's edges (SPRINT-108 RPC). */
  syncEdgesAtomic(ns: string, docPath: string, desired: EdgeRow[]): Promise<void>;
  /** Remove all edges touching a doc. Used by delete + reconcile. */
  deleteEdges(ns: string, docPath: string): Promise<void>;
  /** Wipe every edge in the namespace. Used by backfill. */
  clearEdges(ns: string): Promise<void>;
  /** Bulk insert (backfill path). */
  insertEdges(rows: EdgeRow[]): Promise<void>;
}
