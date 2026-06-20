import { clerkSetup } from "@clerk/testing/playwright";

async function globalSetup(): Promise<void> {
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
