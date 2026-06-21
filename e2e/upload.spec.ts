// Authenticated upload spec — closes the regression gap left by SPRINT-046.
//
// The drag-drop/paste image-upload path has bitten us twice
// (SPRINT-043, SPRINT-045). Every fix has shipped without test coverage,
// so the bug keeps coming back. This spec signs in as the test Clerk user
// and hits `/api/image` directly with a real FormData payload — the same
// underlying call the browser makes when a user drops an image.
//
// Why not simulate drag-drop in the DOM? Headless Playwright drag-drop is
// fragile across Chromium builds; the hidden `<input type="file">` (or in
// this case the FormData POST) is the underlying mechanism either way, so
// targeting the API directly is both closer-to-truth and far more stable.

import { expect, test } from "@playwright/test";
import { signIn } from "./helpers/auth";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const FIXTURE_PNG_PATH = fileURLToPath(
  new URL("./fixtures/vault/test-image.png", import.meta.url),
);

const hasClerkCreds = Boolean(
  process.env.E2E_CLERK_USER_USERNAME && process.env.E2E_CLERK_USER_PASSWORD,
);

test.describe("upload (authenticated)", () => {
  test.skip(
    !hasClerkCreds,
    "E2E_CLERK_USER_USERNAME / E2E_CLERK_USER_PASSWORD not set — skipping authed suite",
  );

  test("POST /api/image creates a vault doc and returns a public Supabase URL", async ({ page, baseURL }) => {
    await signIn(page);
    // Navigate to `/me` to force Clerk middleware to issue the
    // server-side session cookie. clerk.signIn() (Backend API) sets the
    // client-side session, but the HttpOnly cookie that /api/image's
    // server-side `auth()` reads is only minted on the next request to
    // a Clerk-aware route. Without this navigation, page.request.post()
    // hits /api/image with no cookie and gets a 401.
    await page.goto("/me");
    await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), {
      timeout: 10_000,
    });

    const png = await readFile(FIXTURE_PNG_PATH);
    const res = await page.request.post(`${baseURL ?? ""}/api/image`, {
      multipart: {
        file: {
          name: "e2e-fixture.png",
          mimeType: "image/png",
          buffer: png,
        },
        title: "E2E Fixture",
      },
    });

    expect(res.status(), "/api/image accepted the upload").toBe(200);

    const body = (await res.json()) as {
      doc_path?: string;
      image_url?: string;
      doc_created?: boolean;
      error?: string;
    };

    // Shape — every field must be present and well-formed.
    expect(body.error, "no error in response").toBeUndefined();
    expect(body.doc_created, "doc was created").toBe(true);
    expect(body.doc_path, "doc_path is a path under images/").toMatch(
      /^images\/.+\.md$/,
    );
    expect(body.image_url, "image_url is a public Supabase Storage URL").toMatch(
      /^https:\/\/.+\.supabase\.co\/storage\/v1\/object\/public\/vault-images\/.+\.png$/,
    );

    // Round-trip — the image bytes must actually be fetchable from the URL.
    // This is what the renderer does when it embeds the image. If Supabase
    // bucket policy regressed, this catches it.
    const imageRes = await page.request.get(body.image_url!);
    expect(imageRes.status(), "uploaded image is publicly fetchable").toBe(200);
    expect(imageRes.headers()["content-type"]).toContain("image/png");
  });
});
