// SPRINT-165: HARD RULE 11 regression spec for the auto-heal daemon
// route auth. The route runs backfillNamespace as admin across every
// namespace — auth failure would be a catastrophic disclosure (any
// unauthenticated caller could trigger the heal or leak metrics).
//
// Fail-closed contract: when CRON_SECRET is unset in the environment
// (as it is in CI and unset prod deploys), the endpoint refuses ALL
// requests with 503. Regressing to "no secret configured = no auth"
// would open the door. This spec pins the fail-closed behaviour.
//
// Auth-enabled behaviour (401 on wrong bearer, 200 on right bearer)
// requires CRON_SECRET set in the process env — verified manually via
// `curl -H "Authorization: Bearer $CRON_SECRET" $PROD/api/cron/...`.

import { expect, test } from "@playwright/test";

const ROUTE = "http://127.0.0.1:3000/api/cron/auto-heal-namespaces";

test.describe("auto-heal cron auth (SPRINT-165)", () => {
  test("fail-closed: CRON_SECRET unset → 503 cron_not_configured", async ({ request }) => {
    // In CI/local, CRON_SECRET isn't set. The route MUST refuse rather
    // than treat "no secret" as "auth bypassed".
    const res = await request.get(ROUTE);
    expect(res.status()).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("cron_not_configured");
  });

  test("fail-closed applies even with a bearer header", async ({ request }) => {
    // Regression guard: nothing about supplying an Authorization header
    // should short-circuit the fail-closed check.
    const res = await request.get(ROUTE, {
      headers: { authorization: "Bearer any-value" },
    });
    expect(res.status()).toBe(503);
  });

  test("fail-closed applies to POST too (405 or 503, never 200)", async ({ request }) => {
    // Route only exports GET — POST should 405. But even if someone
    // adds POST later, the auth gate applies first.
    const res = await request.post(ROUTE, {
      headers: { authorization: "Bearer any-value" },
      data: {},
    });
    // Next 16 returns 405 for method-not-allowed on route handlers
    // that don't export the verb. Accept either 405 or 503.
    expect([405, 503]).toContain(res.status());
  });
});
