// Smoke suite: minimal coverage of routes a Ralph loop would notice
// breaking the soonest. Anonymous-only (no Clerk sign-in here).
//
// SPRINT-047 hardening: every spec asserts on real backend content, not
// just `status < 500`. The previous tolerance lets a workflow pass with
// empty Supabase env — see [[EMDEE_OS — LEARNINGS]] entry "Tolerant smoke
// tests false-pass on empty env".

import { expect, test } from "@playwright/test";

test.describe("smoke (anonymous)", () => {
  test("public root renders the LANDING doc and the sign-in CTA", async ({ page }) => {
    // SPRINT-052 (SIG-009): root no longer exposes the operator's INFO. The
    // public namespace renders LANDING.md at `/` plus a sign-in CTA banner.
    const response = await page.goto("/");
    expect(response, "navigation returned a response").not.toBeNull();
    expect(response!.status(), "no 5xx on public root").toBeLessThan(500);
    await expect(page.locator("body")).toBeVisible();
    // LANDING's H1 / value-prop content is what visitors see — pin on a
    // distinctive phrase from the placeholder body. Edits to LANDING content
    // (via MCP, post-merge) should keep the "knowledge graph" phrase to
    // keep this assertion valid; otherwise update the spec at the same time.
    await expect(
      page.getByText(/your knowledge graph/i).first(),
    ).toBeVisible({ timeout: 10_000 });
    // CTA banner — SSR'd at the top of the shell for unauthenticated visitors.
    await expect(
      page.getByRole("link", { name: /sign in to start your own vault/i }).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("/api/index returns the public namespace with EMDEE as root", async ({ request, baseURL }) => {
    // SPRINT-077: LANDING.md removed. Public namespace shows only the virtual
    // EMDEE system node — no stored files required.
    const res = await request.get(`${baseURL ?? ""}/api/index?ns=public`);
    expect(res.status(), "/api/index is up").toBe(200);
    const body = (await res.json()) as {
      docs?: Array<{ path?: string }>;
      entry?: string | null;
    };
    expect(Array.isArray(body.docs), "docs array shape").toBe(true);
    expect(body.entry, "entry is EMDEE.md").toBe("EMDEE.md");
    const paths = (body.docs ?? []).map((d) => d.path);
    expect(paths).toContain("EMDEE.md");
  });

  test("/api/index returns 304 when If-None-Match matches (SPRINT-144 ETag cache)", async ({ request, baseURL }) => {
    // First fetch — grab the ETag.
    const first = await request.get(`${baseURL ?? ""}/api/index?ns=public`);
    expect(first.status(), "first fetch is 200").toBe(200);
    const etag = first.headers()["etag"];
    expect(etag, "response carries ETag header").toBeTruthy();

    // Second fetch with If-None-Match — should be 304 no body.
    const second = await request.get(`${baseURL ?? ""}/api/index?ns=public`, {
      headers: { "if-none-match": etag },
    });
    expect(second.status(), "matching If-None-Match returns 304").toBe(304);
    const secondBody = await second.body();
    expect(secondBody.length, "304 body is empty").toBe(0);
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
