// Clerk sign-in helper for Playwright.
//
// Uses @clerk/testing's `clerk.signIn({ emailAddress })` — the ticket flow.
// This is the only path that fully bypasses Clerk's hosted UI:
//   • bot-protection challenge
//   • "Use another method" chooser (when OAuth + password are both enabled)
//   • new-device email verification (which fires on fresh CI runners)
//
// Mechanism: @clerk/testing hits Clerk's Backend API
// (`signInTokens.createSignInToken`) to mint a one-time token bound to the
// user, then submits it via the `ticket` strategy and waits for
// `window.Clerk.user !== null`. The password strategy in the same helper
// doesn't wait for the user to land, and silently no-ops if Clerk's
// `signIn.create()` returns `needs_first_factor` because of a verification
// challenge — which is why the previous password attempt left the
// server-side session cookie unset.
//
// Requires CLERK_SECRET_KEY (for Backend API access) and
// E2E_CLERK_USER_USERNAME to be the user's primary **email address**.

import { clerk } from "@clerk/testing/playwright";
import type { Page } from "@playwright/test";

export async function signIn(page: Page): Promise<void> {
  const emailAddress = process.env.E2E_CLERK_USER_USERNAME;
  if (!emailAddress) {
    throw new Error(
      "signIn(): E2E_CLERK_USER_USERNAME must be set to the test user's email address",
    );
  }

  // The page must be on a Clerk-aware route before signIn so the frontend
  // SDK has loaded. The public root is the cheapest such page.
  await page.goto("/");

  await clerk.signIn({ page, emailAddress });

  // One-shot diagnostic — if this fails again we want to know whether the
  // session cookie made it to the app domain. Remove on green.
  const cookies = await page.context().cookies();
  // eslint-disable-next-line no-console
  console.log(
    "[e2e] cookies after signIn:",
    cookies.map((c) => `${c.name}@${c.domain}`).join(", "),
  );
}
