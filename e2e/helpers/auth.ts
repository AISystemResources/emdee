// Clerk sign-in helper for Playwright, ported from DOUBLELEAD.
//
// Usage:
//
//   import { signIn } from "./helpers/auth";
//   await signIn(page);
//   await page.goto("/me");
//
// Strategy: setupClerkTestingToken bypasses Clerk's bot-protection challenge,
// then we hit the hosted /sign-in page and submit the user/password from env.
// Selectors target Clerk's stable name="identifier"/name="password" fields.

import { setupClerkTestingToken } from "@clerk/testing/playwright";
import type { Page } from "@playwright/test";

const SIGN_IN_PATH = "/sign-in";

export async function signIn(page: Page): Promise<void> {
  const username = process.env.E2E_CLERK_USER_USERNAME;
  const password = process.env.E2E_CLERK_USER_PASSWORD;
  if (!username || !password) {
    throw new Error(
      "signIn(): E2E_CLERK_USER_USERNAME / E2E_CLERK_USER_PASSWORD must be set",
    );
  }

  await setupClerkTestingToken({ page });
  await page.goto(SIGN_IN_PATH);

  // Clerk's <SignIn /> renders an identifier field first, then password on
  // the next step. Both inputs use `name="identifier"` / `name="password"`
  // which is stable across versions. Press Enter to advance rather than
  // clicking "Continue" — when OAuth + email/password are both enabled,
  // /continue/i can match multiple buttons and trigger a strict-mode violation.
  const emailInput = page.getByRole("textbox", { name: /email|username|identifier/i });
  await emailInput.fill(username);
  await emailInput.press("Enter");

  await page.getByRole("textbox", { name: /password/i }).fill(password);
  await page.getByRole("textbox", { name: /password/i }).press("Enter");

  // EMDEE redirects authenticated users from `/` → `/{userId}` (see app/page.tsx).
  // Accept any URL outside the sign-in flow as "signed in".
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), {
    timeout: 20_000,
  });
}
