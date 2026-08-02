import { auth } from "@clerk/nextjs/server";
import { buildIndexFromContents, type DocNode, type Edge } from "@/src/core/indexer";
import { getVaultStorage } from "@/src/lib/storage";
import type { VaultStorage } from "@/src/lib/storage";
import { adminClient } from "@/src/lib/supabase/admin";
import { ensureProfile } from "@/src/lib/supabase/oauth";
import { vaultListTag } from "@/src/lib/cache/bust";
import { backfillNamespace } from "@/src/core/syncDocEdges";
import { cloudDatabase } from "@/src/lib/database";
import { fetchSharesForGrantee } from "@/src/lib/share/grants";
import { listTrashedPaths } from "@/src/lib/trash/state";
import { ownerTitleFromEmail, normalizeOwnerTitle, ownerNodeScaffold } from "@/src/lib/owner/identity";
import { clerkClient } from "@clerk/nextjs/server";
import type { ToolContext } from "@/src/lib/mcp/tools/types";
import { SYSTEM_NODE_PATHS, missingSystemNodeFiles } from "@/src/lib/system-nodes";

const SHARED_PREFIX = "__shared:";
const SHARED_ROOT_PATH = "SHARED.md";
const sharedKey = (ownerId: string, path: string) => `${SHARED_PREFIX}${ownerId}:${path}`;

function summaryFromContent(content: string): string {
  // First blockquote line after the H1, before the next heading. Matches the
  // indexer's contract (src/core/indexer.ts deriveSummary) so shared docs
  // surface a summary the same way native ones do.
  let seenH1 = false;
  for (const raw of content.split(/\r?\n/)) {
    const h = raw.match(/^(#{1,6})\s+/);
    if (h) {
      if (!seenH1 && h[1] === "#") {
        seenH1 = true;
        continue;
      }
      if (seenH1) return "";
    }
    if (!seenH1) continue;
    const bq = raw.match(/^\s*>\s?(.*)$/);
    if (bq) return bq[1].trim();
  }
  return "";
}

// SPRINT-024 Phase 3: dropped `dynamic = "force-dynamic"` so the public
// namespace can sit behind Vercel's edge cache. Personal namespaces are
// still gated by Clerk auth and emit `no-store`; only `?ns=public` gets
// `s-maxage` + a Cache-Tag so `bustVaultCache("public", …)` can purge it
// on writes.
export const runtime = "nodejs";

const EMPTY = { docs: [], edges: [], entry: null };
const NO_STORE = { headers: { "Cache-Control": "no-store" } };


async function getNickname(ns: string): Promise<string | null> {
  try {
    const { data } = await adminClient()
      .from("profiles")
      .select("nickname")
      .eq("clerk_id", ns)
      .single();
    return data?.nickname ?? null;
  } catch {
    return null;
  }
}

/**
 * SPRINT-058 (SIG-006): plant the user's owner node on first vault seed.
 * Uses the pre-set nickname from profiles if available; falls back to
 * deriving a title from the user's primary email from Clerk.
 *
 * Idempotent: skips the write if the file already exists in the namespace.
 * Network/Clerk failures don't block the seed — caller logs and proceeds.
 */
async function ensureOwnerNode(storage: VaultStorage, ns: string, nickname: string | null): Promise<void> {
  let title: string;
  if (nickname) {
    title = normalizeOwnerTitle(nickname);
  } else {
    let email = "";
    try {
      const client = await clerkClient();
      const user = await client.users.getUser(ns);
      const primary = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId);
      email = primary?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? "";
    } catch (e) {
      console.error(`clerk user lookup failed for ${ns}:`, e);
    }
    title = ownerTitleFromEmail(email);
  }

  const ownerPath = `${ns}/${title}.md`;
  if (await storage.exists(ownerPath)) return;
  await storage.write(ownerPath, ownerNodeScaffold(title));
}


function publicCacheHeaders(ns: string): Record<string, string> {
  return {
    "Cache-Control": "public, s-maxage=60, stale-while-revalidate=600",
    // Vercel-specific: when present, `revalidateTag(tag)` purges any
    // edge entry carrying this tag. Off Vercel this header is ignored
    // and the s-maxage TTL is the only invalidator (60s eventual).
    "Cache-Tag": vaultListTag(ns),
  };
}

/**
 * Copy every file under `public/` into `{ns}/` as a starter set. Called once
 * the first time an authenticated user opens their own empty workspace, so
 * they see the same intro tree visitors see at `/`.
 */
async function seedFromPublic(storage: VaultStorage, ns: string): Promise<void> {
  const seeds = await storage.listWithContent("public/");
  await Promise.all(
    seeds.map(async (f) => {
      const relative = f.path.slice("public/".length);
      // Never overwrite system-node paths — they get injected with current
      // content at index-build time and a seed copy would lock in stale content.
      // Skip system-node paths and LANDING.md — system nodes are injected
      // virtually at index-build time; LANDING.md is a public homepage doc.
      if (SYSTEM_NODE_PATHS.has(relative) || relative === "LANDING.md") return;
      await storage.write(`${ns}/${relative}`, f.content);
    })
  );

}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const ns = url.searchParams.get("ns") ?? "public";

  const { storage, prefix, isLocal } = getVaultStorage(ns);

  // Cloud-mode prerequisites: Supabase credentials must be present.
  if (
    !isLocal &&
    (!process.env.NEXT_PUBLIC_SUPABASE_URL ||
      (!process.env.SUPABASE_SECRET_KEY && !process.env.SUPABASE_SERVICE_ROLE_KEY))
  ) {
    return Response.json(EMPTY, NO_STORE);
  }

  // Auth gate for personal namespaces. `public` is open; everything else must
  // be owned by the requester. Local mode is single-tenant — skip the gate.
  let canSeedIfEmpty = false;
  if (!isLocal && ns !== "public") {
    const { userId } = await auth();
    if (!userId || userId !== ns) {
      return Response.json(EMPTY, NO_STORE);
    }
    canSeedIfEmpty = true;
    // Await ensureProfile so a Clerk-instance migration (dev→prod ID remap)
    // can populate vault_files before the seed-if-empty check below runs.
    // For repeat visitors the call short-circuits immediately (email already set).
    await ensureProfile(userId).catch(() => {});
  }

  // SPRINT-144 (Tier 2 egress fix): ETag preflight. Before paying for
  // the full-content listing (which egressed ~4 MB per personal-namespace
  // page load on Edmund's 1224-doc vault), compute a cheap fingerprint
  // from listMeta (just file_path + updated_at — a few hundred KB max)
  // and compare against the client's If-None-Match. Repeated loads
  // without writes return 304 with ~1 KB of headers, no body.
  //
  // ETag shape: `"${count}-${maxUpdatedAt}"`. Covers add/delete (count
  // moves), any edit (max ts moves), rename (rename touches updated_at
  // via storage.write hook).
  //
  // For shared docs (cross-namespace): first-cut ETag ignores share
  // changes. Rare enough that the trade-off (occasional stale share
  // view for one page reload) is acceptable. Users can hard-refresh.
  const includeTrashedFlag = url.searchParams.get("include_trashed") === "true";
  let etagCandidate: string | null = null;
  try {
    const meta = await storage.listMeta(prefix || undefined);
    const maxUpdated = meta.reduce((mx, m) => (m.updatedAt > mx ? m.updatedAt : mx), "");
    etagCandidate = `"${meta.length}-${maxUpdated || "empty"}-t${includeTrashedFlag ? "1" : "0"}"`;
    if (request.headers.get("if-none-match") === etagCandidate) {
      return new Response(null, {
        status: 304,
        headers: {
          ETag: etagCandidate,
          // no-cache = "revalidate with server before using cache" —
          // enables browser If-None-Match on next request. no-store
          // (previous behaviour) would kill the caching win entirely.
          "Cache-Control": ns === "public" ? "public, max-age=0, must-revalidate" : "private, no-cache",
        },
      });
    }
  } catch {
    // Fall through — a broken listMeta shouldn't block the full path.
  }

  // SPRINT-146a: ?meta=true lets the renderer fetch (path, title, summary,
  // edges) without paying for content. Default stays full-content to
  // preserve backwards compatibility for every existing caller (including
  // the current renderer, until it opts in in a follow-up).
  const metaOnly = url.searchParams.get("meta") === "true";
  let listed: Awaited<ReturnType<typeof storage.listWithContent>>;
  try {
    listed = metaOnly
      ? await storage.listMetadata(prefix || undefined)
      : await storage.listWithContent(prefix || undefined);
  } catch {
    listed = [];
  }

  // First-visit seed: copy public/ → {userId}/ once (cloud only). Seed
  // writes go through storage.write which dual-updates the cache, so the
  // re-list after seeding hits the fast path.
  if (listed.length === 0 && canSeedIfEmpty) {
    // Gate on nickname: new users must pick a display name before we seed
    // their vault, so the owner node gets the right title from the start.
    const nickname = await getNickname(ns);
    if (!nickname) {
      return Response.json({ docs: [], edges: [], entry: null, needsNickname: true }, NO_STORE);
    }
    await seedFromPublic(storage, ns);
    // SPRINT-058 (SIG-006): plant the user's owner node using the nickname.
    try {
      await ensureOwnerNode(storage, ns, nickname);
    } catch (e) {
      console.error(`owner-node seed failed for ${ns}:`, e);
    }
    // Rebuild all edges after seed + owner node are both written, so
    // EMDEE→<owner> and EMDEE→system-node edges all resolve in one pass.
    try {
      await backfillNamespace(cloudDatabase(), ns);
    } catch (e) {
      console.error(`post-seed backfill failed for ${ns}:`, e);
    }
    try {
      listed = await storage.listWithContent(prefix);
    } catch {
      listed = [];
    }
  }

  // Public namespace may be empty in storage — system nodes are injected
  // below so this is fine; don't short-circuit on empty listed.
  if (listed.length === 0 && ns !== "public") {
    return Response.json(EMPTY, NO_STORE);
  }

  let files = listed.map((f) => ({
    path: prefix ? f.path.slice(prefix.length) : f.path,
    content: f.content,
    // SPRINT-146a: propagate pre-derived title / summary from listMetadata
    // through to the indexer so meta mode doesn't need content to work.
    title: f.title,
    summary: f.summary,
  }));

  // SPRINT-057 (SIG-008): filter out trashed docs from the renderer's view.
  // Trash state lives in `.emdee/trashed.json` (per namespace). The doc's
  // markdown is unchanged and its edges in doc_edges stay intact for
  // lossless restore — only the renderer hides it. A future GRAVEYARD view
  // can surface trashed docs by passing `?include_trashed=true`.
  const includeTrashed = url.searchParams.get("include_trashed") === "true";
  if (!includeTrashed) {
    const trashCtx: ToolContext = isLocal
      ? (await import("@/src/lib/mcp/tools/context")).localToolContext(process.env.EMDEE_DOCS ?? "")
      // Read-only trash-list lookup for a namespace-scoped index render.
      // Not user-authenticated; scope not applicable.
      : { mode: "cloud", storage, userId: ns, db: cloudDatabase(), scope: "mcp" };
    try {
      const trashed = await listTrashedPaths(trashCtx);
      if (trashed.size > 0) {
        files = files.filter((f) => !trashed.has(f.path));
      }
    } catch (e) {
      // Don't fail the whole index if the trash sidecar is malformed —
      // surface to the server log and proceed with no filter.
      console.error(`[api/index] trash filter skipped for ${ns}:`, e);
    }
  }

  // Inject system-default nodes for any not already in the user's storage.
  // These are the OS layer of every vault — always present, never deletable,
  // content managed here rather than per-user in Supabase. Users who have
  // customised a node (written it via MCP) see their stored version instead.
  // Public namespace gets EMDEE injected so visitors see the vault root.
  if (!isLocal) {
    for (const sn of missingSystemNodeFiles(files.map((f) => f.path))) {
      files.push({ ...sn, title: undefined, summary: undefined });
    }
  }

  // Strip leftover fixture/demo files from the public namespace so visitors
  // only see the EMDEE root, not internal test content. Then inject a USER
  // placeholder so visitors see the personal-node slot in the graph.
  if (!isLocal && ns === "public") {
    files = files.filter((f) => SYSTEM_NODE_PATHS.has(f.path));
    files.push({
      path: "USER.md",
      content: "# USER\n\n> Your personal node — sign in to create your own vault.\n\n## Child of\n\n* [[EMDEE]]\n",
      title: undefined,
      summary: undefined,
    });
  }

  const index = buildIndexFromContents(files);

  // Public namespace always lands on EMDEE — the canonical vault root.
  if (ns === "public") {
    index.entry = "EMDEE.md";
  }

  // SPRINT-018 Phase 3: in cloud mode, override the indexer's parsed
  // edges with the materialized doc_edges rows. Same suppression rules
  // (the backfill + write hooks apply them at insert time), but no
  // markdown re-parse cost here. Local dev keeps the indexer's edges so
  // EMDEE_DOCS workflows don't need a database round-trip.
  // Public namespace is skipped — its docs are entirely virtual system
  // nodes that never write to doc_edges, so the indexer's parsed edges
  // from systemNodeContent() are always correct and authoritative.
  if (!isLocal && ns !== "public") {
    // Supabase enforces a server-side `db-max-rows: 1000` cap that
    // overrides client `.range()`. For vaults with > 1000 edges (which
    // the user crossed at ~600 docs), the first attempt at lifting the
    // cap by passing `.range(0, 49999)` silently truncated to 1000.
    // Paginate explicitly — 1000 rows per request — and stop when a
    // page returns less than full. At 1622 edges this is 2 round-trips
    // (still well under the 100ms tier budget).
    const PAGE_SIZE = 1000;
    const rows: { from_path: string; to_path: string; kind: string }[] = [];
    let pageStart = 0;
    let error: Error | { message: string } | null = null;
    while (true) {
      // ORDER BY is mandatory for paginated .range(). Without a stable
      // sort, Postgres can return rows in different orders across the
      // two pages, silently dropping or duplicating rows at the boundary.
      // Symptom: leaf docs (e.g. seminar concepts) lose their hierarchy
      // edge and surface as top-level "orphans" in the sidebar tree.
      const { data, error: pageErr } = await adminClient()
        .from("doc_edges")
        .select("from_path, to_path, kind")
        .eq("namespace", ns)
        .order("from_path", { ascending: true })
        .order("to_path", { ascending: true })
        .order("kind", { ascending: true })
        .range(pageStart, pageStart + PAGE_SIZE - 1);
      if (pageErr) { error = pageErr; break; }
      if (!data || data.length === 0) break;
      rows.push(...data);
      if (data.length < PAGE_SIZE) break;
      pageStart += PAGE_SIZE;
    }
    // Empty-edge guard: a freshly-seeded namespace can have docs in
    // vault_files but zero rows in doc_edges (the per-file syncDocEdges
    // calls during seed race each other; see `seedFromPublic`). If
    // doc_edges is empty for a non-empty vault, fall back to the
    // indexer's parsed edges (same as local mode) so the renderer
    // shows a real graph instead of a flat orphan list. A subsequent
    // backfill (kicked off in seedFromPublic, or run manually via
    // `npx tsx scripts/backfill-doc-edges.ts --namespace <ns>`) will
    // populate doc_edges so future requests use the fast path.
    if (!error && rows.length > 0) {
      // Assoc rows are stored once per direction in doc_edges (two rows
      // per pair); the indexer's Edge[] expects one row per pair with
      // from < to. Dedupe accordingly so the graph renderer doesn't
      // double-draw associates.
      const seen = new Set<string>();
      const edges: Edge[] = [];
      for (const r of rows) {
        const from = r.from_path as string;
        const to = r.to_path as string;
        const kind = r.kind as "hierarchy" | "assoc";
        if (kind === "assoc") {
          const [lo, hi] = from < to ? [from, to] : [to, from];
          const key = `A:${lo}::${hi}`;
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push({ from: lo, to: hi, kind });
        } else {
          const key = `H:${from}::${to}`;
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push({ from, to, kind });
        }
      }
      // Defensive trash-cascade: doc_edges retains rows for trashed docs
      // (so restore is lossless), but the renderer must not see edges
      // pointing at filtered docs — they materialize as phantom nodes
      // labeled by raw path (titleFor falls back when the target isn't
      // in index.docs). Drop any edge whose endpoint isn't a kept doc.
      const keptPaths = new Set(index.docs.map((d) => d.path));
      index.edges = edges.filter((e) => keptPaths.has(e.from) && keptPaths.has(e.to));
    }
  }

  // Shared-doc merge (SPRINT-030). For authenticated personal namespaces,
  // inline docs and edges the user has access to via `doc_shares` so the
  // graph and sidebar agree on a single index. Public namespace
  // short-circuits — `public` has no grantees and we don't want the share
  // lookup polluting the edge cache.
  if (!isLocal && ns !== "public") {
    try {
      const shares = await fetchSharesForGrantee(ns);
      const hasSharedRoot = index.docs.some((d) => d.path === SHARED_ROOT_PATH);

      // SPRINT-060 (SIG-007 part B): dedupe synthetic owner nodes — if
      // the same owner shares multiple subtrees, they get ONE owner node
      // grouping them all (mirrors Google Drive's "Shared with me" by
      // contributor). Path scheme `__shared_owner:<ownerId>` keeps it
      // distinct from regular `__shared:<ownerId>:<path>` doc keys.
      const ownerNodePathFor = (ownerId: string) => `__shared_owner:${ownerId}`;
      const synthesizedOwners = new Set<string>();

      for (const group of shares) {
        const pathSet = new Set(group.docs.map((d) => d.path));
        for (const doc of group.docs) {
          const sharedDoc: DocNode = {
            path: sharedKey(group.ownerId, doc.path),
            title: doc.title,
            content: doc.content,
            summary: summaryFromContent(doc.content),
            parents: [],
            children: [],
            associates: [],
            mentions: [],
          };
          index.docs.push(sharedDoc);
        }
        for (const e of group.edges) {
          if (!pathSet.has(e.from) || !pathSet.has(e.to)) continue;
          index.edges.push({
            from: sharedKey(group.ownerId, e.from),
            to: sharedKey(group.ownerId, e.to),
            kind: e.kind,
          });
        }

        // SPRINT-060: synthesize per-owner intermediate. SHARED → owner
        // → share-root, instead of SHARED → share-root directly. Owner
        // node title derives from the contributor's email local-part
        // (same helper SIG-006 uses for the user's own owner node), so
        // "Alice's BUSINESS" surfaces as `SHARED → ALICE → BUSINESS`
        // rather than just `SHARED → BUSINESS`.
        const ownerSyntheticPath = ownerNodePathFor(group.ownerId);
        const ownerDisplayTitle = group.ownerEmail
          ? ownerTitleFromEmail(group.ownerEmail)
          : `USER-${group.ownerId.slice(-6).toUpperCase()}`;

        if (!synthesizedOwners.has(group.ownerId)) {
          synthesizedOwners.add(group.ownerId);
          index.docs.push({
            path: ownerSyntheticPath,
            title: ownerDisplayTitle,
            content: "",
            summary: `Shared content from ${group.ownerEmail ?? ownerDisplayTitle}.`,
            parents: [],
            children: [],
            associates: [],
            mentions: [],
          });
          // SHARED → owner-intermediate (one edge per owner, not per group).
          if (hasSharedRoot) {
            index.edges.push({
              from: SHARED_ROOT_PATH,
              to: ownerSyntheticPath,
              kind: "hierarchy",
            });
          }
        }

        // owner-intermediate → share-root (one per share group).
        if (pathSet.has(group.shareRoot)) {
          index.edges.push({
            from: ownerSyntheticPath,
            to: sharedKey(group.ownerId, group.shareRoot),
            kind: "hierarchy",
          });
        }
      }
    } catch (e) {
      // Don't fail the whole index fetch if share lookup explodes. The
      // sidebar's separate `/api/shared` call still provides a fallback
      // surface for the user even if their graph misses the share branch.
      console.error(`shared-doc merge failed for ${ns}:`, e);
    }
  }

  // SPRINT-144: attach ETag + no-cache so the browser sends If-None-Match
  // on the next request. Personal namespaces get no-cache (must revalidate
  // with the server, but 304 is cheap). Public keeps the CDN-friendly
  // 60s s-maxage since public content is intentionally shared.
  const headers: Record<string, string> = ns === "public"
    ? { ...publicCacheHeaders(ns) }
    : { "Cache-Control": "private, no-cache" };
  if (etagCandidate) headers.ETag = etagCandidate;
  return Response.json(index, { headers });
}
