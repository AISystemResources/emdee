-- SPRINT-140: SQLite backend for VaultDatabase (SIG-032 Phase 2).
-- Mirrors the Postgres schema at supabase/migrations/*.sql for parity.
-- Every schema change here needs a matching thought about whether the
-- Postgres side also needs updating (and vice versa).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS vault_files (
  namespace TEXT NOT NULL,
  file_path TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  -- SPRINT-143: persisted H1 title so syncDocEdges doesn't pull the
  -- content column on every write. SQLite backend derives it in-app at
  -- putFile time (no regex engine here — plain JS extract). Postgres
  -- side uses a GENERATED column (migration 20260726120000).
  title TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  summary_hash TEXT,
  content_hash_at_summary_write TEXT,
  PRIMARY KEY (namespace, file_path)
);

CREATE INDEX IF NOT EXISTS vault_files_ns_prefix_idx
  ON vault_files (namespace, file_path);

CREATE TABLE IF NOT EXISTS doc_edges (
  namespace TEXT NOT NULL,
  from_path TEXT NOT NULL,
  to_path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('hierarchy','assoc')),
  label TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (namespace, from_path, to_path, kind)
);

-- SPRINT-117 one_parent constraint: at most one hierarchy edge per
-- (namespace, to_path). Partial UNIQUE index (SQLite >= 3.8 supports it).
CREATE UNIQUE INDEX IF NOT EXISTS doc_edges_one_parent
  ON doc_edges (namespace, to_path)
  WHERE kind = 'hierarchy';

CREATE INDEX IF NOT EXISTS doc_edges_ns_from_idx
  ON doc_edges (namespace, from_path);
CREATE INDEX IF NOT EXISTS doc_edges_ns_to_idx
  ON doc_edges (namespace, to_path);

-- FTS5 for searchFiles. Mirrors Postgres tsvector functionality from
-- migration 20260725000001 but with SQLite's built-in FTS5 engine.
-- Content-external table pattern: FTS5 owns just the index; canonical
-- content stays in vault_files. Triggers keep them in sync.
CREATE VIRTUAL TABLE IF NOT EXISTS vault_files_fts USING fts5(
  namespace UNINDEXED,
  file_path UNINDEXED,
  content,
  tokenize = 'porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS vault_files_fts_ai AFTER INSERT ON vault_files BEGIN
  INSERT INTO vault_files_fts (namespace, file_path, content)
  VALUES (new.namespace, new.file_path, new.content);
END;

CREATE TRIGGER IF NOT EXISTS vault_files_fts_ad AFTER DELETE ON vault_files BEGIN
  DELETE FROM vault_files_fts
   WHERE namespace = old.namespace AND file_path = old.file_path;
END;

CREATE TRIGGER IF NOT EXISTS vault_files_fts_au AFTER UPDATE ON vault_files BEGIN
  DELETE FROM vault_files_fts
   WHERE namespace = old.namespace AND file_path = old.file_path;
  INSERT INTO vault_files_fts (namespace, file_path, content)
  VALUES (new.namespace, new.file_path, new.content);
END;

-- Schema-version pragma for future migrations.
PRAGMA user_version = 2;
