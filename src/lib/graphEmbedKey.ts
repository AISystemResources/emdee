// SPRINT-172 follow-up: derive the graph-embed signing key from the
// service role key instead of requiring a dedicated env var.
//
// HKDF-style construction:
//   GRAPH_ROOT = HMAC(SERVICE_ROLE_KEY, "emdee:graph-embed:v1")
//   userKey    = HMAC(GRAPH_ROOT, userId)
//   sig        = HMAC(userKey, `${path}:${exp}`)
//
// - The "v1" domain separator is public; bump it to invalidate all
//   outstanding URLs without touching the underlying key.
// - Per-user derivation means leaking one user's URL/sig reveals nothing
//   about other users' URLs. HMAC is one-way — signatures don't leak
//   keys.
// - The service role key never appears in a URL or response. If an
//   attacker can read it, they already own the whole DB and forging a
//   graph URL is the least of your problems.

import { createHmac, timingSafeEqual } from "node:crypto";

const DOMAIN = "emdee:graph-embed:v1";

let cachedRoot: Buffer | null = null;

function graphRoot(): Buffer | null {
  if (cachedRoot) return cachedRoot;
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) return null;
  cachedRoot = createHmac("sha256", secret).update(DOMAIN).digest();
  return cachedRoot;
}

function userKey(userId: string): Buffer | null {
  const root = graphRoot();
  if (!root) return null;
  return createHmac("sha256", root).update(userId).digest();
}

export function signGraphEmbed(ns: string, path: string, exp: number): string | null {
  const key = userKey(ns);
  if (!key) return null;
  return createHmac("sha256", key).update(`${path}:${exp}`).digest("hex");
}

export function verifyGraphEmbed(ns: string, path: string, exp: number, sig: string): boolean {
  const expected = signGraphEmbed(ns, path, exp);
  if (!expected) return false;
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(sig, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
