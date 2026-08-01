// SPRINT-177: owner-only aggregate metrics for whatelz.ai's founder
// cockpit. Auth is a single shared Bearer token whose SHA-256 hash is
// stored in `public.internal_secrets` (kind='owner_metrics'). NEVER
// share this endpoint with any customer surface — aggregate-across-
// all-tenants data.

import { NextResponse } from "next/server";
import { collectOwnerMetrics } from "@/src/lib/owner-metrics";
import { verifyInternalSecret } from "@/src/lib/internal-secrets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
};

// In-memory sliding-window rate limit. 60 req/min per token. Single-
// instance scope only — Vercel spawns multiple function instances so
// this under-limits (each instance has its own bucket). Acceptable
// because there's exactly one consumer at 4-req-per-day cadence.
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 60;
const buckets = new Map<string, number[]>();

function rateLimitOk(bucketKey: string): boolean {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const timestamps = (buckets.get(bucketKey) ?? []).filter((t) => t > cutoff);
  if (timestamps.length >= MAX_REQUESTS) {
    buckets.set(bucketKey, timestamps);
    return false;
  }
  timestamps.push(now);
  buckets.set(bucketKey, timestamps);
  return true;
}

function jsonWithHeaders(body: unknown, status: number, extra?: Record<string, string>): NextResponse {
  const res = NextResponse.json(body, { status });
  for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...(extra ?? {}) })) {
    res.headers.set(k, v);
  }
  return res;
}

export async function GET(req: Request): Promise<NextResponse> {
  const provided = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!(await verifyInternalSecret("owner_metrics", provided))) {
    return jsonWithHeaders({ error: "unauthorized" }, 401);
  }
  // Bucket key = the token itself (only ever one active token per kind).
  if (!rateLimitOk(provided)) {
    return jsonWithHeaders({ error: "rate_limited" }, 429, { "Retry-After": "60" });
  }
  const metrics = await collectOwnerMetrics();
  return jsonWithHeaders(metrics, 200);
}

// Any non-GET verb: 405 with Allow header.
async function methodNotAllowed(): Promise<NextResponse> {
  const res = jsonWithHeaders({ error: "method_not_allowed" }, 405);
  res.headers.set("Allow", "GET");
  return res;
}

export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const HEAD = methodNotAllowed;
export const OPTIONS = methodNotAllowed;
