// Smoke suite: minimal coverage of routes a Ralph loop would notice
// breaking the soonest. Anonymous-only (no Clerk sign-in here).
//
// SPRINT-047 hardening: every spec asserts on real backend content, not
// just `status < 500`. The previous tolerance lets a workflow pass with
// empty Supabase env — see [[EMDEE_OS — LEARNINGS]] entry "Tolerant smoke
// tests false-pass on empty env".

import { expect, test } from "@playwright/test";

test.describe("smoke (anonymous)", () => {
  test("public workspace renders and includes the seeded INFO node", async ({ page }) => {
    const response = await page.goto("/");
    expect(response, "navigation returned a response").not.toBeNull();
    expect(response!.status(), "no 5xx on public root").toBeLessThan(500);
    // Body has to actually paint — defends against empty-env white screen.
    await expect(page.locator("body")).toBeVisible();
    // Sidebar / tree should mention the seeded fixture root. Use a regex
    // so we tolerate either the bare basename ("INFO") or a fuller title
    // ("EMDEE_TEST_VAULT — INFO") depending on what surface the renderer
    // surfaces in the navigation chrome.
    await expect(page.getByText(/INFO/i).first()).toBeVisible({ timeout: 10_000 });
  });

  test("/api/index returns the seeded fixture vault for the public namespace", async ({ request, baseURL }) => {
    // Content-asserting smoke: hits the data plane directly and verifies
    // the seed actually landed in EMDEE-test. If this fails, either the
    // seed script broke or the test Supabase project isn't wired up.
    const res = await request.get(`${baseURL ?? ""}/api/index?ns=public`);
    expect(res.status(), "/api/index is up").toBe(200);
    const body = (await res.json()) as {
      docs?: Array<{ path?: string }>;
    };
    expect(Array.isArray(body.docs), "docs array shape").toBe(true);
    const paths = (body.docs ?? []).map((d) => d.path);
    // The seed plants at minimum INFO.md plus the three node-type fixtures.
    expect(paths).toContain("INFO.md");
    expect(paths).toContain("hubs/test-hub.md");
    expect(paths).toContain("templates/PERSON.md");
    expect(paths).toContain("skills/test-skill.md");
  });

  test("sign-in route renders the Clerk identifier field", async ({ page }) => {
    const response = await page.goto("/sign-in");
    expect(response, "navigation returned a response").not.toBeNull();
    expect(response!.status(), "no 5xx on /sign-in").toBeLessThan(500);
    // Clerk's <SignIn /> renders an identifier input on its first step.
    // If Clerk env is missing or misconfigured, the component never mounts
    // and this assertion fails loudly — the empty-env false-pass we just
    // fixed in SPRINT-047.
    await expect(
      page.getByRole("textbox", { name: /email|username|identifier/i }),
    ).toBeVisible({ timeout: 10_000 });
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
