-- Enforce one parent per doc in the hierarchy graph.
-- A doc with two hierarchy parents causes circular moves in enforce-hub-folders
-- and ambiguous graph traversal. The lint_doc warning (multiple_child_of) catches
-- this at write time via MCP; this index makes it impossible at the DB level.
--
-- Using a partial unique index on (namespace, to_path) WHERE kind = 'hierarchy'
-- so assoc edges (kind = 'assoc') are unaffected.

CREATE UNIQUE INDEX doc_edges_one_parent
  ON doc_edges (namespace, to_path)
  WHERE kind = 'hierarchy';
