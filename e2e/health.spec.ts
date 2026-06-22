// SPRINT-053 (SIG-002): smoke coverage for the liveness endpoint.
//
// Hits `GET /api/health` and asserts the response shape. Cheap and stable —
// runs against the e2e dev server with no fixtures required. Detects
// regressions like accidentally adding an auth gate, breaking the JSON shape,
// or returning a non-200 status.

import { expect, test } from "@playwright/test";

test.describe("health (anonymous)", () => {
  test("GET /api/health returns ok + ISO deployed_at", async ({ request, baseURL }) => {
    const res = await request.get(`${baseURL ?? ""}/api/health`);
    expect(res.status(), "/api/health is up").toBe(200);

    const body = (await res.json()) as {
      status?: string;
      deployed_at?: string;
    };

    expect(body.status, "status is the literal 'ok' string").toBe("ok");
    // ISO-8601 shape: YYYY-MM-DDTHH:mm:ss(.sss)Z or with offset
    expect(body.deployed_at, "deployed_at is ISO-8601").toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/,
    );
    // Sanity: parses to a real Date
    const parsed = new Date(body.deployed_at!);
    expect(Number.isNaN(parsed.getTime()), "deployed_at parses as Date").toBe(false);
  });
});
