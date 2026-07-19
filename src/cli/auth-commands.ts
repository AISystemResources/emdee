// SPRINT-091: entrypoint for `emdee login | logout | whoami`.
//
// Shelled from bin/emdee.js via `npx tsx`. Kept separate from read-commands
// so the auth flow's node:http server + browser-open logic doesn't get
// loaded on every read invocation.

import { parseArgs } from "node:util";
import { login, deleteCreds, loadCreds, whoami, DEFAULT_HOST, NeedsLoginError } from "./auth";

async function cmdLogin(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { host: { type: "string" } }, strict: true });
  const host = values.host ?? DEFAULT_HOST;
  const creds = await login(host);
  let email: string | null = null;
  try {
    const w = await whoami(creds);
    email = w.email;
  } catch {
    // Non-fatal; login succeeded.
  }
  process.stdout.write(
    `Logged in to ${host}${email ? ` as ${email}` : ""}.\n` +
      `Credentials saved to ~/.config/emdee/credentials.json (mode 0600).\n`,
  );
}

async function cmdLogout(): Promise<void> {
  const removed = await deleteCreds();
  process.stdout.write(removed ? "Logged out.\n" : "Already logged out.\n");
}

async function cmdWhoami(): Promise<void> {
  const creds = await loadCreds();
  if (!creds) {
    process.stderr.write("Not logged in. Run `emdee login`.\n");
    process.exit(1);
  }
  try {
    const w = await whoami(creds);
    process.stdout.write(`${w.email ?? "(no email on record)"}\nnamespace: ${w.namespace}\nhost: ${creds.host}\n`);
  } catch (err) {
    if (err instanceof NeedsLoginError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

const [, , sub, ...rest] = process.argv;

async function main(): Promise<void> {
  switch (sub) {
    case "login":
      await cmdLogin(rest);
      return;
    case "logout":
      await cmdLogout();
      return;
    case "whoami":
      await cmdWhoami();
      return;
    default:
      process.stderr.write(`unknown subcommand: ${sub ?? "(none)"}\nusage: emdee <login|logout|whoami> [--host URL]\n`);
      process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
