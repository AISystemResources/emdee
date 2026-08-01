// SPRINT-128: client-side response cache for read-only CLI calls.
//
// Repeat calls (`emdee get-doc --path X --remote` twice in a minute) currently
// re-hit the cloud with full network + auth cost. This cache stores each
// read-only tool response at ~/.emdee/cache/<hash>.json with a TTL. Subsequent
// calls within the TTL return the cached response instantly.
//
// Scope:
// - Only tools on `CACHEABLE_TOOLS` are cached (read-only, side-effect-free).
// - Cache key includes tool name + args + mode (remote/local) + doc-scope.
// - TTL is 5 min by default; configurable via ~/.emdee/config.json
//   `cache_ttl_seconds`; bypass with `--no-cache` flag on the invoking verb.
// - Write tools invalidate the whole cache on success (simple + correct;
//   avoids stale reads after a patch/write).

import { readFile, writeFile, mkdir, rm, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";

const DEFAULT_TTL_SECONDS = 300;

const CACHEABLE_TOOLS = new Set<string>([
  "get_doc",
  "get_summary",
  "get_neighbors",
  "get_context",
  "read_doc_section",
  "list_docs",
  "list_summary_drift",
  "search",
  "batch_get_summary",
  "batch_get_doc",
  "lint_doc",
  "lint_vault",
  "find_similar",
  "list_tickets",
]);

function cacheDir(): string {
  return path.join(os.homedir(), ".emdee", "cache");
}

function cacheKey(toolName: string, args: Record<string, unknown>, remote: boolean, scope: string): string {
  const material = `${toolName}::${JSON.stringify(args)}::${remote ? "r" : "l"}::${scope}`;
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

async function loadTtl(): Promise<number> {
  try {
    const cfgPath = path.join(os.homedir(), ".emdee", "config.json");
    const raw = await readFile(cfgPath, "utf8");
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    const t = cfg.cache_ttl_seconds;
    if (typeof t === "number" && t > 0) return t;
  } catch {}
  return DEFAULT_TTL_SECONDS;
}

interface CacheEntry {
  toolName: string;
  createdAt: number;
  response: unknown;
}

export function isCacheable(toolName: string): boolean {
  return CACHEABLE_TOOLS.has(toolName);
}

/**
 * Return a cached response if fresh, or null. Never throws — a broken cache
 * shouldn't break the CLI.
 */
export async function readCache(
  toolName: string,
  args: Record<string, unknown>,
  remote: boolean,
  scope: string,
): Promise<unknown | null> {
  if (!isCacheable(toolName)) return null;
  try {
    const key = cacheKey(toolName, args, remote, scope);
    const file = path.join(cacheDir(), `${key}.json`);
    const raw = await readFile(file, "utf8");
    const entry = JSON.parse(raw) as CacheEntry;
    const ttl = await loadTtl();
    if ((Date.now() - entry.createdAt) / 1000 > ttl) return null;
    return entry.response;
  } catch {
    return null;
  }
}

export async function writeCacheEntry(
  toolName: string,
  args: Record<string, unknown>,
  remote: boolean,
  scope: string,
  response: unknown,
): Promise<void> {
  if (!isCacheable(toolName)) return;
  try {
    const dir = cacheDir();
    await mkdir(dir, { recursive: true });
    const key = cacheKey(toolName, args, remote, scope);
    const file = path.join(dir, `${key}.json`);
    const entry: CacheEntry = { toolName, createdAt: Date.now(), response };
    await writeFile(file, JSON.stringify(entry), "utf8");
  } catch {
    // Cache write failures are silent — worst case is we miss the cache
    // next time.
  }
}

/**
 * Drop every cache entry. Called after write tools succeed so we never
 * serve a stale read after a mutation. Cheap: rm -rf the cache dir.
 */
export async function purgeCache(): Promise<void> {
  try {
    await rm(cacheDir(), { recursive: true, force: true });
  } catch {}
}

/**
 * Report cache stats for `emdee cache` command — count of entries + oldest.
 */
export async function cacheStats(): Promise<{ entries: number; oldest_seconds: number | null }> {
  try {
    const files = await readdir(cacheDir());
    if (files.length === 0) return { entries: 0, oldest_seconds: null };
    let oldest = Date.now();
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = await readFile(path.join(cacheDir(), f), "utf8");
        const entry = JSON.parse(raw) as CacheEntry;
        if (entry.createdAt < oldest) oldest = entry.createdAt;
      } catch {}
    }
    return {
      entries: files.filter((f) => f.endsWith(".json")).length,
      oldest_seconds: Math.round((Date.now() - oldest) / 1000),
    };
  } catch {
    return { entries: 0, oldest_seconds: null };
  }
}
