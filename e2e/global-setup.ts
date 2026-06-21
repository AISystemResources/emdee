import { clerkSetup } from "@clerk/testing/playwright";
import { seedVault } from "./seed-vault";

async function globalSetup(): Promise<void> {
  // 1. Seed the EMDEE-test public namespace with fixture vault content.
  //    Runs regardless of Clerk state — anonymous specs depend on this
  //    seeded content even when Clerk env is missing.
  try {
    await seedVault();
  } catch (err) {
    process.stdout.write(
      `[e2e] seedVault() failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    // Don't throw — anonymous specs will still run; they'll just fail
    // loudly on the content assertion instead of silently mis-seeding.
  }

  // 2. Bootstrap Clerk testing helpers if dev keys are present.
  const hasClerkKeys = Boolean(
    process.env.CLERK_SECRET_KEY && process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  );
  if (!hasClerkKeys) {
    process.stdout.write(
      "[e2e] Clerk env vars missing — auth-dependent suites will skip.\n",
    );
    return;
  }

  try {
    await clerkSetup();
  } catch (err) {
    process.stdout.write(
      `[e2e] clerkSetup() failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

export default globalSetup;
