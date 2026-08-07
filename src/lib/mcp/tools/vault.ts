import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { buildIndex, buildIndexFromContents, type DocIndex } from "../../../core/indexer";
import { adminClient } from "../../supabase/admin";
import { subscribeNamespaceInvalidate } from "../../cache/invalidation";
import { missingSystemNodeFiles } from "../../system-nodes";
import type { ToolContext } from "./types";

/**
 * Paths under SHARED_PATH_PREFIX point at docs owned by another user that
 * this user has been granted read access to. Format:
 *   __shared__/<owner_clerk_id>/<rel_path>
 * These look like normal vault paths to MCP clients but are routed
 * cross-namespace by readVaultFile and refused by every write op.
 */
export const SHARED_PATH_PREFIX = "__shared__/";

export function validatePath(rel: string): void {
  if (!rel || rel.includes("..")) throw new Error("invalid path");
  if (!rel.endsWith(".md")) throw new Error("path must end in .md");
}

function localSafePath(docsDir: string, rel: string): string {
  const resolved = path.resolve(docsDir, rel);
  if (!resolved.startsWith(docsDir + path.sep) && resolved !== docsDir) {
    throw new Error("path escapes docs directory");
  }
  return resolved;
}

function parseSharedPath(rel: string): { ownerId: string; relPath: string } | null {
  if (!rel.startsWith(SHARED_PATH_PREFIX)) return null;
  const rest = rel.slice(SHARED_PATH_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash === -1) return null;
  return { ownerId: rest.slice(0, slash), relPath: rest.slice(slash + 1) };
}

async function listSharedDocsForGrantee(granteeId: string): Promise<Array<{ ownerId: string; relPath: string }>> {
  const { data } = await adminClient()
    .from("doc_shares")
    .select("owner_id, path_prefix")
    .eq("grantee_id", granteeId);
  return (data ?? []).map((r) => ({ ownerId: r.owner_id as string, relPath: r.path_prefix as string }));
}

async function hasShareAccess(granteeId: string, ownerId: string, relPath: string): Promise<boolean> {
  const { data } = await adminClient()
    .from("doc_shares")
    .select("id")
    .eq("grantee_id", granteeId)
    .eq("owner_id", ownerId)
    .eq("path_prefix", relPath)
    .maybeSingle();
  return !!data;
}

/**
 * Direct match OR ancestor match for `permission='write'`. Ancestor walk
 * uses path conventions (cascade-by-hierarchy): write on
 * `projects/DOUBLELEAD.md` covers `projects/DOUBLELEAD/IDEAS/NewIdea.md`.
 * The strict-ancestor form (`<parts>/...md`) avoids cross-prefix false
 * positives like `DOUBLELEAD-OFFSHOOT.md`.
 */
async function isWritableSharedPath(
  granteeId: string,
  ownerId: string,
  relPath: string,
): Promise<boolean> {
  const admin = adminClient();

  const { data: direct } = await admin
    .from("doc_shares")
    .select("id")
    .eq("grantee_id", granteeId)
    .eq("owner_id", ownerId)
    .eq("path_prefix", relPath)
    .eq("permission", "write")
    .maybeSingle();
  if (direct) return true;

  const parts = relPath.split("/");
  const candidates: string[] = [];
  for (let i = parts.length - 1; i > 0; i--) {
    candidates.push(parts.slice(0, i).join("/") + ".md");
  }
  if (candidates.length > 0) {
    const { data: anc } = await admin
      .from("doc_shares")
      .select("path_prefix")
      .eq("grantee_id", granteeId)
      .eq("owner_id", ownerId)
      .eq("permission", "write")
      .in("path_prefix", candidates);
    if ((anc?.length ?? 0) > 0) return true;
  }

  // Sibling-directory fallback: the share root (e.g. signals/SIGNALS.md) lives
  // at the same level as the new file (signals/SIG-009.md), so neither a direct
  // nor a directory-ancestor match fires. If ANY write-permission row exists for
  // a file in the same directory, the grantee's cascade write grant covers it.
  const dir = parts.slice(0, -1).join("/");
  if (!dir) return false;
  const { data: sib } = await admin
    .from("doc_shares")
    .select("id")
    .eq("grantee_id", granteeId)
    .eq("owner_id", ownerId)
    .eq("permission", "write")
    .like("path_prefix", `${dir}/%`)
    .limit(1);
  return (sib?.length ?? 0) > 0;
}

/**
 * SPRINT-032: after a write-permission grantee creates a doc under a
 * shared subtree, the share API never inserted a doc_shares row for the
 * new path — so neither the writer nor any other grantee of the share
 * root sees it. Mirror the cascade by inserting one row per
 * (grantee, share_root) for the new path, copying each grantee's existing
 * permission. Read grantees still see (read-only); write grantees can
 * keep editing. Idempotent — repeat writes upsert to the same rows.
 *
 * Best-effort: a failure here is logged by the caller but doesn't fail
 * the underlying write.
 */
async function propagateShareToNewPath(
  ownerId: string,
  newPath: string,
  writerGranteeId: string,
): Promise<void> {
  const admin = adminClient();

  // 1. Which share_roots authorised this write?
  // First try ancestor-level matches (e.g. DOUBLELEAD.md covers DOUBLELEAD/**).
  // If that finds nothing, fall back to sibling-directory: the share root lives
  // at the same folder level as the new file (e.g. signals/SIGNALS.md is the
  // root for signals/SIG-009.md). Without this fallback, propagation silently
  // fails for the common case where the root is an index file in a sub-folder.
  const parts = newPath.split("/");
  const candidates: string[] = [];
  for (let i = parts.length - 1; i > 0; i--) {
    candidates.push(parts.slice(0, i).join("/") + ".md");
  }

  let authRows: { share_root: string | null }[] | null = null;
  if (candidates.length > 0) {
    const { data } = await admin
      .from("doc_shares")
      .select("share_root")
      .eq("owner_id", ownerId)
      .eq("grantee_id", writerGranteeId)
      .eq("permission", "write")
      .in("path_prefix", candidates);
    authRows = data;
  }

  if (!authRows || authRows.length === 0) {
    const dir = parts.slice(0, -1).join("/");
    if (!dir) return;
    const { data: sibData } = await admin
      .from("doc_shares")
      .select("share_root")
      .eq("owner_id", ownerId)
      .eq("grantee_id", writerGranteeId)
      .eq("permission", "write")
      .like("path_prefix", `${dir}/%`);
    authRows = sibData;
  }

  if (!authRows || authRows.length === 0) return;

  const shareRoots = [
    ...new Set(
      authRows
        .map((r) => r.share_root as string | null)
        .filter((s): s is string => !!s),
    ),
  ];
  if (shareRoots.length === 0) return;

  // 2. Every grantee of those share_roots, incl. read-only. Same group,
  //    same view.
  const { data: groupRows } = await admin
    .from("doc_shares")
    .select("grantee_id, permission, share_root")
    .eq("owner_id", ownerId)
    .in("share_root", shareRoots);
  if (!groupRows || groupRows.length === 0) return;

  // 3. Dedupe by (grantee, share_root). Write beats read for the same
  //    pair (degenerate case — defensive only).
  type Insert = {
    owner_id: string;
    grantee_id: string;
    path_prefix: string;
    permission: "read" | "write";
    share_root: string;
  };
  const byKey = new Map<string, Insert>();
  for (const r of groupRows) {
    const grantee = r.grantee_id as string;
    const share_root = r.share_root as string;
    const permission = r.permission as "read" | "write";
    const key = `${grantee}::${share_root}`;
    const existing = byKey.get(key);
    if (existing) {
      if (permission === "write" && existing.permission === "read") {
        existing.permission = "write";
      }
      continue;
    }
    byKey.set(key, {
      owner_id: ownerId,
      grantee_id: grantee,
      path_prefix: newPath,
      permission,
      share_root,
    });
  }

  const inserts = Array.from(byKey.values());
  if (inserts.length === 0) return;

  const { error } = await admin
    .from("doc_shares")
    .upsert(inserts, { onConflict: "owner_id,path_prefix,grantee_id" });
  if (error) throw new Error(error.message);
}

/**
 * SPRINT-163: when the OWNER writes a new doc in their own namespace,
 * check if that doc falls under any existing share_root and auto-add
 * doc_shares rows for every grantee. Without this, cascading shares
 * only cover descendants that existed AT SHARE-TIME — new docs added
 * later become invisible to the grantee (Sim Yee's DOUBLELEAD
 * PRODUCTION/MARKETING/OPERATION hubs went missing because they were
 * added after her initial DL share).
 *
 * Sibling-directory heuristic: walk up the new doc's path components,
 * and at the first ancestor dir that has any share rows in the owner's
 * namespace (via path_prefix LIKE `${dir}/%`), pull those shares'
 * share_roots + grantees and propagate. Multiple ORM round-trips but
 * bounded by path depth (typically 4-6). Deepest-match-wins so a
 * nested share (e.g. edmund/projects/doublelead/production/*) is
 * preferred over the outer one.
 *
 * Best-effort — a failure here is logged by the caller but doesn't
 * fail the underlying write.
 */
export async function propagateOwnerWriteToShares(
  ownerId: string,
  newPath: string,
): Promise<void> {
  const admin = adminClient();
  const parts = newPath.split("/");
  if (parts.length < 2) return;

  let matches: Array<{ share_root: string | null; grantee_id: string; permission: "read" | "write" }> = [];
  for (let i = parts.length - 1; i > 0; i--) {
    const dir = parts.slice(0, i).join("/");
    const { data } = await admin
      .from("doc_shares")
      .select("share_root, grantee_id, permission")
      .eq("owner_id", ownerId)
      .not("share_root", "is", null)
      .like("path_prefix", `${dir}/%`);
    if (data && data.length > 0) {
      matches = data as typeof matches;
      break;
    }
  }
  if (matches.length === 0) return;

  const inserts = buildOwnerSharePropagationInserts(matches, newPath, ownerId);
  if (inserts.length === 0) return;
  const { error } = await admin
    .from("doc_shares")
    .upsert(inserts, { onConflict: "owner_id,path_prefix,grantee_id" });
  if (error) throw new Error(error.message);
}

export interface OwnerShareMatch {
  share_root: string | null;
  grantee_id: string;
  permission: "read" | "write";
}

export interface OwnerShareInsert {
  owner_id: string;
  grantee_id: string;
  path_prefix: string;
  permission: "read" | "write";
  share_root: string;
}

/**
 * SPRINT-163: pure dedup + upgrade logic for share propagation.
 * Exported so it can be unit-tested without needing a live Supabase
 * connection. Rules:
 * - One insert per (grantee, share_root) pair.
 * - When the same grantee has both read and write access via different
 *   share_roots, `write` wins (upgrade).
 * - Rows with null share_root are dropped (only cascading shares
 *   propagate).
 */
export function buildOwnerSharePropagationInserts(
  matches: OwnerShareMatch[],
  newPath: string,
  ownerId: string,
): OwnerShareInsert[] {
  const byKey = new Map<string, OwnerShareInsert>();
  for (const r of matches) {
    if (!r.share_root) continue;
    const key = `${r.grantee_id}::${r.share_root}`;
    const existing = byKey.get(key);
    if (existing) {
      if (r.permission === "write" && existing.permission === "read") {
        existing.permission = "write";
      }
      continue;
    }
    byKey.set(key, {
      owner_id: ownerId,
      grantee_id: r.grantee_id,
      path_prefix: newPath,
      permission: r.permission,
      share_root: r.share_root,
    });
  }
  return Array.from(byKey.values());
}

/**
 * SPRINT-035: module-scope `loadVaultIndex` memo. Replaces the per-ctx
 * WeakMap (which was empty per-request because the MCP HTTP route
 * allocates a fresh ToolContext per call — see
 * `app/api/mcp/route.ts:164`), so a single Vercel function instance
 * shares the computed index across all tool calls within the TTL window.
 *
 * Keyed by `(mode, userId | docsDir)` so cross-user requests on the same
 * function instance don't collide. Invalidated whenever a write to that
 * namespace publishes through the invalidation hub (which fires from
 * SupabaseStorage.write / .delete regardless of whether the write
 * originated from MCP, web, or any other surface).
 *
 * TTL bounded so stale reads from silent external mutations (anything
 * bypassing the storage layer) are visible within one minute.
 */
interface IndexMemoEntry {
  promise: Promise<DocIndex>;
  expiresAt: number;
}
const indexMemoByKey = new Map<string, IndexMemoEntry>();
const INDEX_MEMO_TTL_MS = 60_000;

const indexStats = {
  hits: 0,
  misses: 0,
  invalidations: 0,
};

function indexMemoKey(ctx: ToolContext): string {
  return ctx.mode === "local" ? `local:${ctx.docsDir}` : `cloud:${ctx.userId}`;
}

function invalidateIndexMemo(ctx: ToolContext): void {
  if (indexMemoByKey.delete(indexMemoKey(ctx))) indexStats.invalidations++;
}

// Subscribe to namespace-level invalidation events published by
// SupabaseStorage.write / .delete. A write to namespace `X` clears the
// `cloud:X` memo so the next read sees the fresh state. Cross-namespace
// shared writes (Sim Yee → Edmund's vault) fire with Edmund's namespace,
// so Edmund's memo clears even though Sim Yee was the writer.
subscribeNamespaceInvalidate((namespace) => {
  if (indexMemoByKey.delete(`cloud:${namespace}`)) indexStats.invalidations++;
});

export function getIndexMemoStats(): {
  hits: number;
  misses: number;
  invalidations: number;
  size: number;
  hitRate: number;
} {
  const total = indexStats.hits + indexStats.misses;
  return {
    hits: indexStats.hits,
    misses: indexStats.misses,
    invalidations: indexStats.invalidations,
    size: indexMemoByKey.size,
    hitRate: total === 0 ? 0 : indexStats.hits / total,
  };
}

async function buildVaultIndex(ctx: ToolContext): Promise<DocIndex> {
  if (ctx.mode === "local") return buildIndex(ctx.docsDir);

  const ownPrefix = `${ctx.userId}/`;
  const ownFiles = await ctx.storage.listWithContent(ownPrefix);
  const ownWithContent = ownFiles.map((f) => ({
    path: f.path.slice(ownPrefix.length),
    content: f.content,
  }));
  // SPRINT-093: inject the 5 canonical system nodes when the user hasn't
  // written a stored version. Matches the /api/index injection so MCP
  // readers see the same starter set the web renderer does.
  const virtuals = missingSystemNodeFiles(ownWithContent.map((f) => f.path));
  const ownIndex = buildIndexFromContents([...ownWithContent, ...virtuals]);

  const shared = await listSharedDocsForGrantee(ctx.userId);
  if (shared.length === 0) return ownIndex;

  const sharedFiles = await Promise.all(
    shared.map(async (s) => ({
      path: `${SHARED_PATH_PREFIX}${s.ownerId}/${s.relPath}`,
      content: (await ctx.storage.read(`${s.ownerId}/${s.relPath}`)) ?? "",
    }))
  );
  const sharedIndex = buildIndexFromContents(sharedFiles);

  return {
    docs: [...ownIndex.docs, ...sharedIndex.docs],
    edges: [...ownIndex.edges, ...sharedIndex.edges],
    entry: ownIndex.entry,
  };
}

/**
 * Builds the index of the user's own vault, then appends docs shared with
 * them. Both sub-indexes are sourced via storage.listWithContent / the
 * cache so the bulk read is one round-trip. Edges from the two
 * sub-indexes don't cross-link — wiki-link resolution stays within each
 * owner's namespace, so the grantee can navigate shared docs by title
 * without leaking back to their own vault.
 *
 * Memoised at module scope keyed by `(mode, userId)`: see `indexMemoByKey` above.
 */
export async function loadVaultIndex(ctx: ToolContext): Promise<DocIndex> {
  const key = indexMemoKey(ctx);
  const hit = indexMemoByKey.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    indexStats.hits++;
    return hit.promise;
  }
  const promise = buildVaultIndex(ctx).catch((err) => {
    // Don't cache failures — a transient Supabase blip shouldn't poison
    // future calls.
    indexMemoByKey.delete(key);
    throw err;
  });
  indexMemoByKey.set(key, { promise, expiresAt: Date.now() + INDEX_MEMO_TTL_MS });
  indexStats.misses++;
  return promise;
}

export async function readVaultFile(ctx: ToolContext, rel: string): Promise<string | null> {
  if (ctx.mode === "local") {
    try {
      return await readFile(localSafePath(ctx.docsDir, rel), "utf8");
    } catch {
      return null;
    }
  }
  const shared = parseSharedPath(rel);
  if (shared) {
    const allowed = await hasShareAccess(ctx.userId, shared.ownerId, shared.relPath);
    if (!allowed) return null;
    return ctx.storage.read(`${shared.ownerId}/${shared.relPath}`);
  }
  return ctx.storage.read(`${ctx.userId}/${rel}`);
}

export class EmptyWriteRefusedError extends Error {
  readonly code = "empty_write_would_delete_content";
  readonly path: string;
  readonly existingLength: number;
  constructor(path: string, existingLength: number) {
    super(`refusing to overwrite non-empty doc ${path} (${existingLength} chars) with empty content`);
    this.path = path;
    this.existingLength = existingLength;
  }
}

/**
 * Write a doc to the caller's vault (or an allowed share). SPRINT-187
 * added the third argument `opts.allowEmpty` — refuses `content` that is
 * effectively empty (`trim().length === 0`) when the target already has
 * non-empty content. Belt-and-braces against the class of drift that
 * silently emptied 3 docs in prod on 2026-08-07. Callers that legitimately
 * write empty content (rare: reset of a scratch doc) must pass
 * `{ allowEmpty: true }`. The higher-level MCP tools (`write_doc`) have
 * their own guard with a cleaner error envelope; this helper's guard
 * catches every other MCP tool + any future caller.
 */
export async function writeVaultFile(
  ctx: ToolContext,
  rel: string,
  content: string,
  opts?: { allowEmpty?: boolean },
): Promise<void> {
  if (content.trim().length === 0 && opts?.allowEmpty !== true) {
    const existing = await readVaultFile(ctx, rel);
    if (existing !== null && existing.trim().length > 0) {
      throw new EmptyWriteRefusedError(rel, existing.length);
    }
  }
  const shared = parseSharedPath(rel);
  if (shared) {
    if (ctx.mode === "local") {
      throw new Error("shared paths not available in local mode");
    }
    const allowed = await isWritableSharedPath(ctx.userId, shared.ownerId, shared.relPath);
    if (!allowed) {
      throw new Error("shared docs are read-only for you — ask the owner to grant write access or make the edit");
    }
    try {
      await ctx.storage.write(`${shared.ownerId}/${shared.relPath}`, content);
    } finally {
      invalidateIndexMemo(ctx);
    }
    // SPRINT-032: extend share rows to the new path so the writer (and
    // other grantees of the same share root) actually see it.
    // Best-effort — a propagation failure is logged but doesn't fail
    // the underlying write (the doc was created successfully).
    try {
      await propagateShareToNewPath(shared.ownerId, shared.relPath, ctx.userId);
    } catch (e) {
      console.error(
        `share propagation failed for ${shared.ownerId}/${shared.relPath}:`,
        e,
      );
    }
    return;
  }
  try {
    if (ctx.mode === "local") {
      const file = localSafePath(ctx.docsDir, rel);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content, "utf8");
      // SPRINT-140: mirror the write into the local SQLite vault_files +
      // resync doc_edges, so lint_orphans / find_similar / reconcile stay
      // coherent with disk truth.
      const { LOCAL_NAMESPACE } = await import("./types");
      const { syncDocEdges } = await import("../../../core/syncDocEdges");
      await ctx.db.putFile(LOCAL_NAMESPACE, rel, content);
      await syncDocEdges(ctx.db, LOCAL_NAMESPACE, rel, content);
      return;
    }
    await ctx.storage.write(`${ctx.userId}/${rel}`, content);
    // SPRINT-163: if this doc falls under any of the owner's active
    // share_roots, auto-add doc_shares rows for every grantee so they
    // see the new doc in context. Prevents the partial-tree orphan bug
    // where an owner adds children to a shared subtree after the
    // initial share and grantees never see them.
    // Best-effort — logged but doesn't fail the write.
    try {
      await propagateOwnerWriteToShares(ctx.userId, rel);
    } catch (e) {
      console.error(
        `owner-write share propagation failed for ${ctx.userId}/${rel}:`,
        e,
      );
    }
  } finally {
    // Bust the per-request memo whether the write succeeded or threw —
    // a partial write may still have committed bucket content, and
    // either way the cached index is stale.
    invalidateIndexMemo(ctx);
  }
}

export async function deleteVaultFile(ctx: ToolContext, rel: string): Promise<void> {
  if (rel.startsWith(SHARED_PATH_PREFIX)) {
    throw new Error("shared docs are read-only — ask the owner to delete");
  }
  try {
    if (ctx.mode === "local") {
      await rm(localSafePath(ctx.docsDir, rel), { force: true });
      // SPRINT-140: mirror the delete into local SQLite.
      const { LOCAL_NAMESPACE } = await import("./types");
      const { deleteDocEdges } = await import("../../../core/syncDocEdges");
      await ctx.db.deleteFile(LOCAL_NAMESPACE, rel);
      await deleteDocEdges(ctx.db, LOCAL_NAMESPACE, rel);
      return;
    }
    await ctx.storage.delete(`${ctx.userId}/${rel}`);
  } finally {
    invalidateIndexMemo(ctx);
  }
}
