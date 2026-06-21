// Clerk sign-in helper for Playwright, ported from DOUBLELEAD then
// tightened against EMDEE's actual sign-in render shape.
//
// Usage:
//
//   import { signIn } from "./helpers/auth";
//   await signIn(page);
//   await page.goto("/me");
//
// Strategy: setupClerkTestingToken bypasses Clerk's bot-protection challenge,
// then we hit the hosted /sign-in page and submit the user/password from env.
// Selectors target Clerk's stable `name="identifier"` / `name="password"`
// HTML attributes rather than ARIA roles, because EMDEE renders Clerk's
// stock <SignIn /> component which (depending on instance settings) can
// surface multiple textbox-role inputs in the same step and trip
// strict-mode resolution on getByRole.

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

  // Wait for Clerk's identifier input to mount and become editable.
  // `name="identifier"` is stable across Clerk JS versions — see
  // @clerk/elements docs.
  const identifierInput = page.locator('input[name="identifier"]');
  await identifierInput.waitFor({ state: "visible", timeout: 15_000 });
  await identifierInput.fill(username);
  await identifierInput.press("Enter");

  // EMDEE's Clerk Development instance enables Google OAuth alongside
  // email/password, so after identifier submission Clerk lands on a
  // "Use another method" screen rather than going straight to the
  // password input. Click the "Sign in with your password" button
  // explicitly so the password input becomes enabled. The button is
  // absent on instances that only have email/password enabled, so
  // we handle the no-op case gracefully.
  const passwordMethodButton = page.getByRole("button", {
    name: /sign in with your password/i,
  });
  try {
    await passwordMethodButton.waitFor({ state: "visible", timeout: 5_000 });
    await passwordMethodButton.click();
  } catch {
    // No "Use another method" screen — Clerk advanced directly to the
    // password step. Common when only email+password is enabled.
  }

  // Password step. The input renders disabled briefly during the step
  // transition; fill() retries until it's enabled.
  const passwordInput = page.locator('input[name="password"]');
  await passwordInput.waitFor({ state: "visible", timeout: 15_000 });
  await passwordInput.fill(password);
  await passwordInput.press("Enter");

  // EMDEE redirects authenticated users from `/` → `/{userId}` (see
  // app/page.tsx). Sign-in component has `fallbackRedirectUrl="/me"`.
  // Accept any URL outside the sign-in flow as "signed in".
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), {
    timeout: 20_000,
  });
}
