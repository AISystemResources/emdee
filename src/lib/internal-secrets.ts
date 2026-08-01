// SPRINT-177 (revised): Postgres-backed store for internal shared
// secrets. Used by /api/internal/* routes that authenticate via a
// single Bearer token instead of Clerk sessions.
//
// Design:
// - The DB stores SHA-256 hex hashes, never the raw token.
// - `verifyInternalSecret(kind, providedToken)` hashes the incoming
//   token client-side and compares to the stored hash in constant time.
// - Lookups are memoised in-process for 60s so we don't round-trip to
//   Postgres on every request. Rotations propagate within that window;
//   for zero-downtime rotation, poll pattern is acceptable at the low
//   request rates these secrets guard.

import { createHash, timingSafeEqual } from "node:crypto";
import { adminClient } from "./supabase/admin";

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  hash: string | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

async function fetchStoredHash(kind: string): Promise<string | null> {
  const { data, error } = await adminClient()
    .from("internal_secrets")
    .select("token_hash")
    .eq("kind", kind)
    .maybeSingle();
  if (error) {
    console.warn(`[internal_secrets] fetch failed for kind=${kind}: ${error.message}`);
    return null;
  }
  return data?.token_hash ?? null;
}

/**
 * Return the SHA-256 hex hash currently stored for `kind`, or null if
 * no row exists. Cached in-process for 60s.
 */
export async function getInternalSecretHash(kind: string): Promise<string | null> {
  const now = Date.now();
  const cached = cache.get(kind);
  if (cached && cached.expiresAt > now) return cached.hash;
  const hash = await fetchStoredHash(kind);
  cache.set(kind, { hash, expiresAt: now + CACHE_TTL_MS });
  return hash;
}

/**
 * True iff `providedToken` (raw string) hashes to the stored hash for
 * `kind`. False if no row is stored, if the hashes differ, or on any
 * lookup error.
 */
export async function verifyInternalSecret(kind: string, providedToken: string): Promise<boolean> {
  if (!providedToken) return false;
  const storedHash = await getInternalSecretHash(kind);
  if (!storedHash) return false;
  return constantTimeHexEqual(hashToken(providedToken), storedHash);
}

/**
 * Test-only: forcibly evict a kind from the in-process cache so a
 * newly-inserted or rotated token is picked up immediately without
 * waiting for TTL expiry. Never call this from production code paths.
 */
export function _invalidateInternalSecretCache(kind: string): void {
  cache.delete(kind);
}
