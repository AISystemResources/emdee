// SPRINT-182: HARD RULE 11 spec for the weekly reconcile-all cron auth.
// Same fail-closed contract as the daily heal cron (SPRINT-165) — this
// endpoint iterates every namespace and rewrites doc_edges, so an
// auth bypass would be equally catastrophic.

import { expect, test } from "@playwright/test";

const ROUTE = "http://127.0.0.1:3000/api/cron/weekly-reconcile-all";

test.describe("weekly reconcile cron auth (SPRINT-182)", () => {
  test("fail-closed: CRON_SECRET unset → 503 cron_not_configured", async ({ request }) => {
    const res = await request.get(ROUTE);
    expect(res.status()).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("cron_not_configured");
  });

  test("fail-closed applies even with a bearer header", async ({ request }) => {
    const res = await request.get(ROUTE, {
      headers: { authorization: "Bearer any-value" },
    });
    expect(res.status()).toBe(503);
  });

  test("fail-closed applies to POST too (405 or 503, never 200)", async ({ request }) => {
    const res = await request.post(ROUTE, {
      headers: { authorization: "Bearer any-value" },
      data: {},
    });
    expect([405, 503]).toContain(res.status());
  });
});
