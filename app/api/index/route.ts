import { auth } from "@clerk/nextjs/server";
import { buildIndexFromContents, type DocNode, type Edge } from "@/src/core/indexer";
import { getVaultStorage } from "@/src/lib/storage";
import type { VaultStorage } from "@/src/lib/storage";
import { adminClient } from "@/src/lib/supabase/admin";
import { ensureProfile } from "@/src/lib/supabase/oauth";
import { vaultListTag } from "@/src/lib/cache/bust";
import { backfillNamespace } from "@/src/core/syncDocEdges";
import { fetchSharesForGrantee } from "@/src/lib/share/grants";

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
      await storage.write(`${ns}/${relative}`, f.content);
    })
  );

  // Per-file syncDocEdges fires inside storage.write, but Promise.all
  // races them against each other — when sync for file A runs, sibling
  // files may not yet exist in vault_files, so cross-doc wiki-links
  // from A fail to resolve and the corresponding edges never land.
  // Result: a freshly-seeded namespace has docs but a partial/empty
  // doc_edges table → flat sidebar, isolated graph nodes.
  //
  // Re-derive the entire namespace's edges once after the seed settles.
  // Throws propagate so the caller (GET handler) can decide whether to
  // proceed; the indexer's parsed edges (kept by the empty-edge guard
  // below) cover the renderer for this single request even if backfill
  // fails.
  try {
    await backfillNamespace(adminClient(), ns);
  } catch (e) {
    console.error(`seed backfill failed for ${ns}:`, e);
  }
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
    // Backfill email + claim any pending share invitations on first index load.
    ensureProfile(userId).catch(() => {});
  }

  let listed: Awaited<ReturnType<typeof storage.listWithContent>>;
  try {
    listed = await storage.listWithContent(prefix || undefined);
  } catch {
    listed = [];
  }

  // First-visit seed: copy public/ → {userId}/ once (cloud only). Seed
  // writes go through storage.write which dual-updates the cache, so the
  // re-list after seeding hits the fast path.
  if (listed.length === 0 && canSeedIfEmpty) {
    await seedFromPublic(storage, ns);
    try {
      listed = await storage.listWithContent(prefix);
    } catch {
      listed = [];
    }
  }

  if (listed.length === 0) {
    return Response.json(EMPTY, NO_STORE);
  }

  const files = listed.map((f) => ({
    path: prefix ? f.path.slice(prefix.length) : f.path,
    content: f.content,
  }));

  const index = buildIndexFromContents(files);

  // SPRINT-018 Phase 3: in cloud mode, override the indexer's parsed
  // edges with the materialized doc_edges rows. Same suppression rules
  // (the backfill + write hooks apply them at insert time), but no
  // markdown re-parse cost here. Local dev keeps the indexer's edges so
  // EMDEE_DOCS workflows don't need a database round-trip.
  if (!isLocal) {
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
      const { data, error: pageErr } = await adminClient()
        .from("doc_edges")
        .select("from_path, to_path, kind")
        .eq("namespace", ns)
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
      index.edges = edges;
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
        // One synthetic edge per share group anchoring the share root to the
        // user's own SHARED.md so the graph can walk SHARED → shared
        // subtree. Skipped if SHARED.md isn't in this user's vault for any
        // reason (seed should always have placed it; defensive only).
        if (hasSharedRoot && pathSet.has(group.shareRoot)) {
          index.edges.push({
            from: SHARED_ROOT_PATH,
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

  const headers = ns === "public" ? publicCacheHeaders(ns) : NO_STORE.headers;
  return Response.json(index, { headers });
}
