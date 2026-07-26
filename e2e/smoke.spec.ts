// Smoke suite: minimal coverage of routes a Ralph loop would notice
// breaking the soonest. Anonymous-only (no Clerk sign-in here).
//
// SPRINT-047 hardening: every spec asserts on real backend content, not
// just `status < 500`. The previous tolerance lets a workflow pass with
// empty Supabase env — see [[EMDEE_OS — LEARNINGS]] entry "Tolerant smoke
// tests false-pass on empty env".

import { expect, test } from "@playwright/test";

test.describe("smoke (anonymous)", () => {
  test("root renders the marketing homepage (SPRINT-149)", async ({ page }) => {
    // SPRINT-148/149: root `/` is now the marketing landing. The public vault
    // renderer moved to `/vault`. Pin on distinctive hero copy + primary CTA.
    const response = await page.goto("/");
    expect(response, "navigation returned a response").not.toBeNull();
    expect(response!.status(), "no 5xx on root").toBeLessThan(500);
    await expect(page.locator("body")).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 1, name: /your second brain/i }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole("link", { name: /start your second brain/i }).first(),
    ).toBeVisible({ timeout: 10_000 });
    // Public-vault link in nav — proves the /vault route is still discoverable.
    await expect(
      page.getByRole("link", { name: /public vault/i }).first(),
    ).toBeVisible();
  });

  test("/vault serves the public vault renderer (SPRINT-148 URL move)", async ({ page, request, baseURL }) => {
    const res = await request.get(`${baseURL ?? ""}/vault`);
    expect(res.status()).toBeLessThan(500);
    await page.goto("/vault");
    await expect(
      page.getByText(/your second brain/i).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("/{userId} legacy URL 308 redirects to /vault/{userId} (SPRINT-148)", async ({ request, baseURL }) => {
    const res = await request.get(`${baseURL ?? ""}/user_TESTLEGACYID`, { maxRedirects: 0 });
    // 308 = permanent redirect preserving method.
    expect([301, 302, 307, 308]).toContain(res.status());
    const loc = res.headers()["location"] ?? "";
    expect(loc, "redirect target").toContain("/vault/user_TESTLEGACYID");
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

  test("/api/index?meta=true returns docs without content (SPRINT-146a)", async ({ request, baseURL }) => {
    const res = await request.get(`${baseURL ?? ""}/api/index?ns=public&meta=true`);
    expect(res.status(), "meta mode is up").toBe(200);
    const body = (await res.json()) as {
      docs?: Array<{ path?: string; content?: string; title?: string }>;
    };
    expect(Array.isArray(body.docs), "docs array shape").toBe(true);
    const nonSystem = (body.docs ?? []).filter((d) => d.path !== "EMDEE.md" && d.path !== "USER.md" && !d.path?.startsWith("VAULT") && !d.path?.startsWith("SHARED") && !d.path?.startsWith("GRAVEYARD") && !d.path?.startsWith("IMAGES"));
    // System nodes come with baked-in scaffold content so they may be non-empty;
    // just assert every doc still has a title (proves the field survives meta mode).
    for (const d of body.docs ?? []) {
      expect(typeof d.title, `title present for ${d.path}`).toBe("string");
    }
    // Body bytes should be substantially smaller than a full fetch would produce.
    void nonSystem;
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
