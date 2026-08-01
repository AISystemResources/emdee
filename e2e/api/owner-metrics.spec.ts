// SPRINT-177: coverage for the owner-only aggregate-metrics endpoint.
//
// Runs against the e2e dev server with OWNER_METRICS_TOKEN pinned by
// playwright.config.ts's webServer env. Self-contained — no external
// secrets required.
//
// Not strictly HARD RULE 11 territory (REST endpoint, not an MCP tool)
// but auth + shape verification is cheap and closes the "runtime broken
// on first call" gap the rule was written to prevent.

import { expect, test } from "@playwright/test";

const TOKEN = "e2e-owner-metrics-token-do-not-use-in-prod";
const PATH = "/api/internal/owner-metrics";

test.describe("owner-metrics endpoint (SPRINT-177)", () => {
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
      headers: { Authorization: `Basic ${TOKEN}` },
    });
    expect(res.status()).toBe(401);
  });

  test("200 + full schema when token matches", async ({ request, baseURL }) => {
    const res = await request.get(`${baseURL ?? ""}${PATH}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
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
    // arr_usd + churn_30d are 0 today per spec.
    expect(business.arr_usd).toBe(0);
    expect(business.churn_30d).toBe(0);

    const usage = body.usage as Record<string, unknown>;
    for (const k of ["docs_total", "docs_added_7d", "sections_added_7d", "sections_updated_7d", "mcp_calls_7d", "cli_syncs_7d"]) {
      expect(usage, `usage.${k} present`).toHaveProperty(k);
    }
    // cli_syncs_7d is null today (not tracked); others are numeric.
    expect(usage.cli_syncs_7d).toBeNull();

    const ph = body.product_health as Record<string, unknown>;
    for (const k of ["uptime_pct_24h", "error_rate_24h", "latest_deploy_sha", "npm_version"]) {
      expect(ph, `product_health.${k} present`).toHaveProperty(k);
    }
    expect(typeof ph.npm_version).toBe("string");
    expect((ph.npm_version as string).length).toBeGreaterThan(0);
    // No monitoring today.
    expect(ph.uptime_pct_24h).toBeNull();
    expect(ph.error_rate_24h).toBeNull();
  });

  test("405 on POST", async ({ request, baseURL }) => {
    const res = await request.post(`${baseURL ?? ""}${PATH}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      data: {},
    });
    expect(res.status()).toBe(405);
    expect(res.headers()["allow"]).toBe("GET");
  });

  test("405 on DELETE", async ({ request, baseURL }) => {
    const res = await request.delete(`${baseURL ?? ""}${PATH}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status()).toBe(405);
  });
});
