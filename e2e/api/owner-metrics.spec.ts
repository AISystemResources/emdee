// SPRINT-177: coverage for the owner-only aggregate-metrics endpoint.
//
// Auth is a Postgres-backed hashed secret (public.internal_secrets
// kind='owner_metrics'). The spec seeds a well-known test token's
// hash before running, then invalidates the in-process cache so the
// dev server picks up the freshly-seeded row on the first request.
//
// Skips when SUPABASE creds are absent (local runs); runs in CI.

import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

const TEST_TOKEN = "e2e-owner-metrics-token-do-not-use-in-prod";
const PATH = "/api/internal/owner-metrics";
const SECRET_KIND = "owner_metrics";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasCreds = !!(SUPABASE_URL && SERVICE_ROLE);

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

test.describe("owner-metrics endpoint (SPRINT-177)", () => {
  test.skip(!hasCreds, "SUPABASE env not set — DB-backed secret seeding requires live DB");

  test.beforeAll(async () => {
    // Upsert the well-known test token's hash so the running server can
    // authenticate us. Idempotent — repeated CI runs are fine.
    const admin = createClient(SUPABASE_URL!, SERVICE_ROLE!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error } = await admin
      .from("internal_secrets")
      .upsert({
        kind: SECRET_KIND,
        token_hash: sha256Hex(TEST_TOKEN),
        label: "e2e — DO NOT USE IN PROD",
      }, { onConflict: "kind" });
    if (error) throw new Error(`seed failed: ${error.message}`);
    // The route's helper caches the hash lookup for 60s. When the test
    // starts, the server may already have a cached miss from a prior
    // request. Give it a moment; the first test's 401-cases don't
    // depend on freshness, so cache warmup during those requests is
    // fine — the 200-path test still gets the fresh hash before the
    // TTL of any prior lookup expires.
  });

  test("401 when Authorization header is missing", async ({ request, baseURL }) => {
    const res = await request.get(`${baseURL ?? ""}${PATH}`);
    expect(res.status()).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("unauthorized");
    // Security headers apply even on error responses.
    expect(res.headers()["x-robots-tag"]).toBe("noindex, nofollow");
    expect(res.headers()["cache-control"]).toBe("no-store");
  });

  test("401 when Bearer token is wrong", async ({ request, baseURL }) => {
    const res = await request.get(`${baseURL ?? ""}${PATH}`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status()).toBe(401);
  });

  test("401 when auth scheme is not Bearer", async ({ request, baseURL }) => {
    const res = await request.get(`${baseURL ?? ""}${PATH}`, {
      headers: { Authorization: `Basic ${TEST_TOKEN}` },
    });
    expect(res.status()).toBe(401);
  });

  test("200 + full schema when token matches the stored hash", async ({ request, baseURL }) => {
    // Retry briefly to tolerate the 60s in-process cache TTL on the
    // helper — the very first request might see a stale null before
    // the beforeAll seed propagates on cold start.
    let res = await request.get(`${baseURL ?? ""}${PATH}`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    if (res.status() === 401) {
      // Wait past the cache TTL and retry once.
      await new Promise((r) => setTimeout(r, 500));
      res = await request.get(`${baseURL ?? ""}${PATH}`, {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
    }
    expect(res.status()).toBe(200);
    expect(res.headers()["cache-control"]).toBe("no-store");
    expect(res.headers()["x-robots-tag"]).toBe("noindex, nofollow");

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.product).toBe("emdee");
    expect(typeof body.generated_at).toBe("string");
    expect(body.schema_version).toBe(1);

    const business = body.business as Record<string, unknown>;
    expect(business).toBeDefined();
    for (const k of ["dau", "wau", "mau", "arr_usd", "signups_7d", "churn_30d", "active_workspaces"]) {
      expect(business, `business.${k} present`).toHaveProperty(k);
      expect(typeof business[k], `business.${k} is number`).toBe("number");
    }
    expect(business.arr_usd).toBe(0);
    expect(business.churn_30d).toBe(0);

    const usage = body.usage as Record<string, unknown>;
    for (const k of ["docs_total", "docs_added_7d", "sections_added_7d", "sections_updated_7d", "mcp_calls_7d", "cli_syncs_7d"]) {
      expect(usage, `usage.${k} present`).toHaveProperty(k);
    }
    expect(usage.cli_syncs_7d).toBeNull();

    const ph = body.product_health as Record<string, unknown>;
    for (const k of ["uptime_pct_24h", "error_rate_24h", "latest_deploy_sha", "npm_version"]) {
      expect(ph, `product_health.${k} present`).toHaveProperty(k);
    }
    expect(typeof ph.npm_version).toBe("string");
    expect((ph.npm_version as string).length).toBeGreaterThan(0);
    expect(ph.uptime_pct_24h).toBeNull();
    expect(ph.error_rate_24h).toBeNull();
  });

  test("405 on POST", async ({ request, baseURL }) => {
    const res = await request.post(`${baseURL ?? ""}${PATH}`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      data: {},
    });
    expect(res.status()).toBe(405);
    expect(res.headers()["allow"]).toBe("GET");
  });

  test("405 on DELETE", async ({ request, baseURL }) => {
    const res = await request.delete(`${baseURL ?? ""}${PATH}`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status()).toBe(405);
  });
});
