// Clerk sign-in helper for Playwright.
//
// Uses @clerk/testing's `clerk.signIn()` — which talks to Clerk's Backend
// API and sets the session cookie directly — instead of driving the
// hosted /sign-in UI. This bypasses:
//   • the bot-protection challenge,
//   • the "Use another method" chooser (when OAuth + password are both enabled),
//   • the new-device email-verification step that fires on fresh CI runners,
//   • any future UI changes Clerk ships to the sign-in component.
//
// Requires CLERK_SECRET_KEY to be set so @clerk/testing can hit the Backend
// API. The test user must already exist in the Clerk instance; we don't
// create it here.

import { clerk } from "@clerk/testing/playwright";
import type { Page } from "@playwright/test";

export async function signIn(page: Page): Promise<void> {
  const username = process.env.E2E_CLERK_USER_USERNAME;
  const password = process.env.E2E_CLERK_USER_PASSWORD;
  if (!username || !password) {
    throw new Error(
      "signIn(): E2E_CLERK_USER_USERNAME / E2E_CLERK_USER_PASSWORD must be set",
    );
  }

  // clerk.signIn() requires the page to be on a Clerk-aware route
  // (i.e. the ClerkProvider has loaded) before it can set the session
  // cookie. Hit the public root first — fast, public, ClerkProvider-wrapped.
  await page.goto("/");

  await clerk.signIn({
    page,
    signInParams: {
      strategy: "password",
      identifier: username,
      password,
    },
  });
}
