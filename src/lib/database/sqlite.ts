// SPRINT-140 (SIG-032 Phase 2): SqliteDatabase — VaultDatabase impl for
// local mode. Runs fully offline. Uses better-sqlite3 (native, sync API)
// under the hood; wraps calls in Promise.resolve to match the async
// VaultDatabase interface.
//
// Atomic edge sync is an in-process TS transaction (SQLite doesn't need
// an RPC — the database is in the same process).
//
// Zero cloud dependencies. This file must never import from
// ../supabase/* or ../storage/SupabaseStorage.

import Database from "better-sqlite3";
import type { Database as SqliteDb } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  VaultDatabase,
  VaultFileRow,
  EdgeRow,
  EdgeFilter,
  ListFilesOptions,
  SummaryDriftOptions,
} from "./types";
import { SQLITE_SCHEMA } from "./sqlite-schema";

// SPRINT-140F: schema is inlined via ./sqlite-schema.ts so it survives
// esbuild bundling into dist/. Previously read via fs sibling lookup,
// which broke `emdee lint-orphans` (and every local-mode verb) in the
// npm-installed CLI because the .sql file wasn't next to the bundle.

export class SqliteDatabase implements VaultDatabase {
  private db: SqliteDb;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(SQLITE_SCHEMA);
    // SPRINT-143 upgrade path: existing DBs (user_version 1) predate
    // the title column. CREATE TABLE IF NOT EXISTS won't add columns
    // to an existing table, so manually ALTER + backfill from content,
    // then bump user_version.
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (row && row.user_version < 2) {
      // ALTER without a value; existing rows get NULL then backfill.
      const cols = this.db.prepare("PRAGMA table_info(vault_files)").all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === "title")) {
        this.db.exec("ALTER TABLE vault_files ADD COLUMN title TEXT");
      }
      // Backfill: derive title from H1 (simple regex, matches putFile logic).
      const rows = this.db
        .prepare("SELECT namespace, file_path, content FROM vault_files WHERE title IS NULL")
        .all() as Array<{ namespace: string; file_path: string; content: string }>;
      const upd = this.db.prepare("UPDATE vault_files SET title = ? WHERE namespace = ? AND file_path = ?");
      const tx = this.db.transaction((batch: typeof rows) => {
        for (const r of batch) {
          const m = (r.content ?? "").match(/^#\s+(.+?)\s*$/m);
          upd.run(m ? m[1].trim() : null, r.namespace, r.file_path);
        }
      });
      tx(rows);
      this.db.exec("PRAGMA user_version = 2");
    }
  }

  close(): void {
    this.db.close();
  }

  async getFile(ns: string, path: string): Promise<VaultFileRow | null> {
    const row = this.db
      .prepare(
        "SELECT namespace, file_path, content, title, updated_at, summary_hash, content_hash_at_summary_write FROM vault_files WHERE namespace = ? AND file_path = ?",
      )
      .get(ns, path) as VaultFileRow | undefined;
    return row ?? null;
  }

  async putFile(
    ns: string,
    path: string,
    content: string,
    meta?: { summary_hash?: string; content_hash_at_summary_write?: string },
  ): Promise<void> {
    // SPRINT-143: derive title in-app (SQLite has no regex engine by
    // default). Mirrors the Postgres GENERATED column: match first H1
    // line, trim, else NULL. Callers fall back to filename slug when
    // title is NULL, matching the resolver's behaviour in syncDocEdges.
    const m = content.match(/^#\s+(.+?)\s*$/m);
    const title = m ? m[1].trim() : null;
    this.db
      .prepare(
        `INSERT INTO vault_files (namespace, file_path, content, title, updated_at, summary_hash, content_hash_at_summary_write)
         VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?)
         ON CONFLICT(namespace, file_path) DO UPDATE SET
           content = excluded.content,
           title = excluded.title,
           updated_at = excluded.updated_at,
           summary_hash = COALESCE(excluded.summary_hash, vault_files.summary_hash),
           content_hash_at_summary_write = COALESCE(excluded.content_hash_at_summary_write, vault_files.content_hash_at_summary_write)`,
      )
      .run(ns, path, content, title, meta?.summary_hash ?? null, meta?.content_hash_at_summary_write ?? null);
  }

  async deleteFile(ns: string, path: string): Promise<void> {
    this.db
      .prepare("DELETE FROM vault_files WHERE namespace = ? AND file_path = ?")
      .run(ns, path);
  }

  async listFiles(ns: string, opts: ListFilesOptions = {}): Promise<VaultFileRow[]> {
    const select = opts.select ?? "*";
    // SQLite has no PostgREST-style select-column parsing; treat "*" as
    // the full row, otherwise pass through as literal SQL.
    const cols = select === "*"
      ? "namespace, file_path, content, title, updated_at, summary_hash, content_hash_at_summary_write"
      : select;
    let sql = `SELECT ${cols} FROM vault_files WHERE namespace = ?`;
    const params: unknown[] = [ns];
    if (opts.prefix) {
      sql += " AND file_path LIKE ?";
      params.push(`${opts.prefix}%`);
    }
    if (opts.order === "file_path_asc" || !opts.order) {
      sql += " ORDER BY file_path ASC";
    }
    if (opts.limit != null) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }
    if (opts.offset != null) {
      sql += " OFFSET ?";
      params.push(opts.offset);
    }
    return this.db.prepare(sql).all(...params) as VaultFileRow[];
  }

  async searchFiles(
    ns: string,
    query: string,
    limit: number,
    excludePath?: string,
  ): Promise<VaultFileRow[]> {
    // FTS5 MATCH; join back to vault_files for the full row.
    // Sanitise query for FTS5 syntax — strip quotes / bare hyphens that
    // FTS5 interprets as operators to avoid parse errors on user text.
    const cleaned = query.replace(/["-]/g, " ").replace(/\s+/g, " ").trim();
    if (!cleaned) return [];
    let sql = `
      SELECT v.namespace, v.file_path, v.content, v.updated_at, v.summary_hash, v.content_hash_at_summary_write
      FROM vault_files_fts f
      JOIN vault_files v ON v.namespace = f.namespace AND v.file_path = f.file_path
      WHERE f.namespace = ? AND vault_files_fts MATCH ?
    `;
    const params: unknown[] = [ns, cleaned];
    if (excludePath) {
      sql += " AND v.file_path != ?";
      params.push(excludePath);
    }
    sql += " ORDER BY rank LIMIT ?";
    params.push(limit);
    return this.db.prepare(sql).all(...params) as VaultFileRow[];
  }

  async getSummaryDrift(ns: string, opts: SummaryDriftOptions = {}): Promise<VaultFileRow[]> {
    return this.listFiles(ns, {
      prefix: opts.prefix,
      select: "file_path, content, content_hash_at_summary_write",
      order: "file_path_asc",
    });
  }

  async getEdges(ns: string, filter: EdgeFilter = {}): Promise<EdgeRow[]> {
    let sql = "SELECT namespace, from_path, to_path, kind, label, position FROM doc_edges WHERE namespace = ?";
    const params: unknown[] = [ns];
    if (filter.from_path) { sql += " AND from_path = ?"; params.push(filter.from_path); }
    if (filter.to_path) { sql += " AND to_path = ?"; params.push(filter.to_path); }
    if (filter.kind) { sql += " AND kind = ?"; params.push(filter.kind); }
    sql += " ORDER BY from_path ASC, to_path ASC";
    return this.db.prepare(sql).all(...params) as EdgeRow[];
  }

  async syncEdgesAtomic(ns: string, docPath: string, desired: EdgeRow[]): Promise<void> {
    // In-process transaction: DELETE-touching-doc + INSERT-desired atomically.
    // Better-sqlite3's .transaction() wraps in BEGIN/COMMIT; any throw rolls back.
    const del = this.db.prepare(
      "DELETE FROM doc_edges WHERE namespace = ? AND (from_path = ? OR to_path = ?)",
    );
    const ins = this.db.prepare(
      "INSERT INTO doc_edges (namespace, from_path, to_path, kind, label, position) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const tx = this.db.transaction((rows: EdgeRow[]) => {
      del.run(ns, docPath, docPath);
      for (const r of rows) ins.run(r.namespace, r.from_path, r.to_path, r.kind, r.label, r.position);
    });
    tx(desired);
  }

  async deleteEdges(ns: string, docPath: string): Promise<void> {
    this.db
      .prepare("DELETE FROM doc_edges WHERE namespace = ? AND (from_path = ? OR to_path = ?)")
      .run(ns, docPath, docPath);
  }

  async clearEdges(ns: string): Promise<void> {
    this.db.prepare("DELETE FROM doc_edges WHERE namespace = ?").run(ns);
  }

  async insertEdges(rows: EdgeRow[]): Promise<void> {
    const ins = this.db.prepare(
      "INSERT INTO doc_edges (namespace, from_path, to_path, kind, label, position) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const tx = this.db.transaction((batch: EdgeRow[]) => {
      for (const r of batch) ins.run(r.namespace, r.from_path, r.to_path, r.kind, r.label, r.position);
    });
    tx(rows);
  }
}
