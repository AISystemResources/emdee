// SPRINT-059 (SIG-007 part A): RBAC check for /api/share — only share
// what you own. Tests the refusal path: an authenticated user trying to
// share a path under `__shared__/` (content shared TO them, not BY them)
// gets a 403.
//
// Doesn't test the success path here — that'd require pre-seeding a doc
// in claude-tester's namespace, which is more setup than this RBAC slice
// warrants. The success path is exercised by the existing share-modal
// UI in the renderer.

import { expect, test } from "@playwright/test";
import { signIn } from "./helpers/auth";

const hasClerkCreds = Boolean(
  process.env.E2E_CLERK_USER_USERNAME && process.env.E2E_CLERK_USER_PASSWORD,
);

test.describe("share RBAC (authenticated)", () => {
  test.skip(
    !hasClerkCreds,
    "E2E_CLERK_USER_USERNAME / E2E_CLERK_USER_PASSWORD not set — skipping authed suite",
  );

  test("POST /api/share refuses paths under __shared__/ with 403", async ({ page, baseURL }) => {
    await signIn(page);
    // Navigate to /me so Clerk's HttpOnly session cookie is minted before
    // the share POST (same pattern as upload.spec.ts).
    await page.goto("/me");
    await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), {
      timeout: 10_000,
    });

    const res = await page.request.post(`${baseURL ?? ""}/api/share`, {
      headers: { "content-type": "application/json" },
      data: {
        path: "__shared__/someone-else/journal.md",
        email: "third-party@example.com",
        permission: "read",
        cascade: false,
      },
      failOnStatusCode: false,
    });

    expect(res.status(), "share refused with 403").toBe(403);
    const body = (await res.json()) as { error?: string; path?: string };
    expect(body.error).toBe("cannot_share_received_content");
    expect(body.path).toBe("__shared__/someone-else/journal.md");
  });

  test("POST /api/share refuses the `__shared__` directory itself", async ({ page, baseURL }) => {
    await signIn(page);
    await page.goto("/me");
    await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), {
      timeout: 10_000,
    });

    const res = await page.request.post(`${baseURL ?? ""}/api/share`, {
      headers: { "content-type": "application/json" },
      data: {
        path: "__shared__",
        email: "third-party@example.com",
        cascade: false,
      },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(403);
  });
});
