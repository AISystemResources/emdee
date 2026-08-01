import { defineConfig } from "@playwright/test";

const isCI = Boolean(process.env.CI);
const skipQuarantine = Boolean(process.env.QUARANTINE_E2E);

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: isCI ? 2 : 0,
  reporter: [["html", { open: "never" }], ["list"]],
  fullyParallel: false,
  workers: isCI ? 1 : undefined,
  testIgnore: skipQuarantine ? ["**/*.quarantine.spec.ts"] : [],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: "npm run dev",
    url: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    reuseExistingServer: !isCI,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
    // Force cloud-mode so e2e runs against the same code path production uses.
    // Without this, a developer's local `EMDEE_DOCS=./docs` would skip the
    // Clerk OAuth gate and a smoke test for that gate would never fire.
    env: { EMDEE_DOCS: "" },
  },
  globalSetup: "./e2e/global-setup.ts",
});
