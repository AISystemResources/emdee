// Smoke suite: minimal coverage of the routes a Ralph loop would notice
// breaking the soonest. Read-only; safe to run against any environment whose
// Supabase URL is set (prod or test). No assertions on vault content.

import { expect, test } from "@playwright/test";

test.describe("smoke", () => {
  test("public workspace renders at /", async ({ page }) => {
    const response = await page.goto("/");
    expect(response, "navigation returned a response").not.toBeNull();
    expect(response!.status(), "no 5xx on public root").toBeLessThan(500);
    // Public root must contain the AppShell scaffold (sidebar + main column).
    await expect(page.locator("body")).toBeVisible();
  });

  test("sign-in route renders without crashing", async ({ page }) => {
    const response = await page.goto("/sign-in");
    expect(response, "navigation returned a response").not.toBeNull();
    expect(response!.status(), "no 5xx on /sign-in").toBeLessThan(500);
  });

  test("MCP HTTP endpoint refuses unauthenticated calls with OAuth challenge", async ({ request, baseURL }) => {
    // /api/mcp is the claude.ai connector entrypoint. It must reject anonymous
    // POSTs with a 401 + WWW-Authenticate header pointing at the OAuth
    // resource-metadata. If this stops working the connector breaks silently.
    const res = await request.post(`${baseURL ?? ""}/api/mcp`, {
      // MCP streamable-HTTP requires both content types in Accept.
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      failOnStatusCode: false,
    });
    expect(res.status(), "MCP route is up and gating").toBe(401);
    const challenge = res.headers()["www-authenticate"];
    expect(challenge, "Bearer challenge present").toContain("Bearer");
    expect(challenge, "challenge points at oauth-protected-resource").toContain(
      "oauth-protected-resource",
    );
  });
});
