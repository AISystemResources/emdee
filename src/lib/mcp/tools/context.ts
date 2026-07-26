// SPRINT-140 (SIG-032 Phase 2): helpers to construct a ToolContext with
// a properly wired VaultDatabase. Every non-e2e caller in local mode
// should use `localToolContext(docsDir)` rather than hand-rolling the
// object — this keeps the SQLite location convention (<docsDir>/.emdee/vault.db)
// in one place.

import { join, relative } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { localDatabase } from "../../database";
import { backfillNamespace } from "../../../core/syncDocEdges";
import type { ToolContext } from "./types";
import { LOCAL_NAMESPACE } from "./types";
import type { VaultDatabase } from "../../database/types";

export function defaultLocalDbPath(docsDir: string): string {
  return join(docsDir, ".emdee", "vault.db");
}

export function localToolContext(docsDir: string, dbPath?: string): ToolContext {
  const db = localDatabase(dbPath ?? defaultLocalDbPath(docsDir));
  return { mode: "local", docsDir, db };
}

/** The namespace string a tool should use for db reads/writes given the ctx. */
export function ctxNamespace(ctx: ToolContext): string {
  return ctx.mode === "cloud" ? ctx.userId : LOCAL_NAMESPACE;
}

/**
 * SPRINT-140: lazy-bootstrap the local DB from `docsDir` when it's empty
 * but the filesystem has docs. Idempotent — no-op once vault_files has
 * any row. Callers must invoke this before any DB-dependent local
 * operation (lint_orphans / find_similar / reconcile).
 *
 * For manual out-of-band edits (user opened a doc in another editor),
 * `emdee reconcile --all` remains the recovery verb.
 */
export async function ensureLocalIndex(ctx: ToolContext): Promise<void> {
  if (ctx.mode !== "local") return;
  const existing = await ctx.db.listFiles(LOCAL_NAMESPACE, { limit: 1, select: "file_path" });
  if (existing.length > 0) return;
  await populateFromFilesystem(ctx.db, ctx.docsDir);
}

function walkMarkdown(root: string): Array<{ rel: string; content: string }> {
  const out: Array<{ rel: string; content: string }> = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.endsWith(".md")) {
        try {
          const st = statSync(full);
          if (!st.isFile()) continue;
        } catch { continue; }
        out.push({ rel: relative(root, full), content: readFileSync(full, "utf8") });
      }
    }
  }
  return out;
}

async function populateFromFilesystem(db: VaultDatabase, docsDir: string): Promise<void> {
  const files = walkMarkdown(docsDir);
  for (const f of files) await db.putFile(LOCAL_NAMESPACE, f.rel, f.content);
  // Rebuild doc_edges from the freshly-populated vault_files.
  await backfillNamespace(db, LOCAL_NAMESPACE);
}
