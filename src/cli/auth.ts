// SPRINT-091: CLI auth — PKCE loopback OAuth against emdee.tech.
//
// Follows RFC 8252 (OAuth 2.0 for native apps) + dynamic client registration
// via /oauth/register (matches Codex + Claude Code patterns already in use).
// Credentials land in ~/.config/emdee/credentials.json at 0600.
//
// Token has a 30-day TTL and there is no refresh grant on the server today,
// so credentials are simple: access_token + client_id + host + saved_at. When
// a token expires, the CLI surfaces `run 'emdee login'` — same UX as Codex.

import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir, unlink, chmod, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";

const CREDS_DIR = path.join(os.homedir(), ".config", "emdee");
const CREDS_PATH = path.join(CREDS_DIR, "credentials.json");
export const DEFAULT_HOST = process.env.EMDEE_CLOUD_URL ?? "https://emdee.tech";
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export interface Credentials {
  access_token: string;
  client_id: string;
  host: string;
  saved_at: number;
}

export class NeedsLoginError extends Error {
  constructor(message = "Run `emdee login` first.") {
    super(message);
    this.name = "NeedsLoginError";
  }
}

// PKCE helpers per RFC 7636.
function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

// File I/O ------------------------------------------------------------------

export async function loadCreds(): Promise<Credentials | null> {
  try {
    const text = await readFile(CREDS_PATH, "utf8");
    return JSON.parse(text) as Credentials;
  } catch {
    return null;
  }
}

async function saveCreds(creds: Credentials): Promise<void> {
  await mkdir(CREDS_DIR, { recursive: true });
  await writeFile(CREDS_PATH, JSON.stringify(creds, null, 2), "utf8");
  await chmod(CREDS_PATH, 0o600);
}

export async function deleteCreds(): Promise<boolean> {
  try {
    await stat(CREDS_PATH);
    await unlink(CREDS_PATH);
    return true;
  } catch {
    return false;
  }
}

// Browser open (best-effort per platform) -----------------------------------

/**
 * Platform-specific browser launch resolver. Pure — returns the spawn
 * argv for a given platform. Exported for regression testing (the actual
 * spawn call is a side effect and can't be portably asserted in CI).
 *
 * - macOS (SPRINT-160B): `open <url>` — real executable.
 * - Linux (SPRINT-160B): `xdg-open <url>` — real executable.
 * - Windows (SPRINT-160C): PowerShell's `Start-Process '<url>'`. Two
 *   prior attempts failed:
 *     1. `spawn("start", [url])` → ENOENT (start is a cmd.exe builtin,
 *        not a standalone executable) — SPRINT-160B.
 *     2. `spawn("cmd", ["/c", "start", "", url])` → browser opened but
 *        URL got truncated at the first `&`, because cmd re-parses `&`
 *        as a command separator when start receives it, even through
 *        quoted args. OAuth URLs are `&`-heavy, so this reliably broke.
 *   PowerShell's Start-Process handles URL arguments as opaque strings —
 *   no cmd escaping, no truncation. `-NoProfile` skips user profile
 *   loading for a faster spawn. Single-quote wrapping treats the URL
 *   literally in PowerShell; embedded `'` doubles to escape (URLs
 *   almost never contain single quotes, but handle it anyway).
 */
export function browserOpenerArgv(url: string, platform: NodeJS.Platform): { cmd: string; args: string[] } {
  if (platform === "darwin") return { cmd: "open", args: [url] };
  if (platform === "win32") {
    const escaped = url.replace(/'/g, "''");
    return { cmd: "powershell", args: ["-NoProfile", "-Command", `Start-Process '${escaped}'`] };
  }
  return { cmd: "xdg-open", args: [url] };
}

function openBrowser(url: string): void {
  const { cmd, args } = browserOpenerArgv(url, process.platform);
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    // spawn's ENOENT surfaces as an async 'error' event, not a sync
    // throw — the outer try/catch alone doesn't catch it. Swallow it
    // here so a missing opener doesn't crash the login flow.
    child.on("error", () => {});
    child.unref();
  } catch {
    // Best-effort — user can copy the URL if this fails.
  }
}

// Dynamic client registration ----------------------------------------------

async function registerClient(host: string, redirectUri: string): Promise<string> {
  const res = await fetch(`${host}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: `emdee-cli (${os.hostname()})`,
      redirect_uris: [redirectUri],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`oauth register failed: ${res.status} ${body}`);
  }
  const body = (await res.json()) as { client_id: string };
  return body.client_id;
}

// Main login flow ----------------------------------------------------------

export async function login(host: string = DEFAULT_HOST): Promise<Credentials> {
  const { verifier, challenge } = generatePkce();
  const state = base64url(randomBytes(16));

  // 1. Bind loopback server on an OS-assigned port so we know the redirect_uri
  //    BEFORE we register the client + open the browser.
  let capturedCode: string | null = null;
  let capturedState: string | null = null;
  const server: Server = createServer((req, res) => {
    if (!req.url) return;
    const u = new URL(req.url, "http://localhost");
    if (u.pathname !== "/callback") {
      res.statusCode = 404;
      res.end();
      return;
    }
    capturedCode = u.searchParams.get("code");
    capturedState = u.searchParams.get("state");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      `<!doctype html><html><body style="font-family:system-ui;padding:2em;text-align:center"><h2>${capturedCode ? "Login complete" : "Login failed"}</h2><p>You can close this tab and return to the terminal.</p></body></html>`
    );
    // Give the browser a beat to render the response before shutting the socket.
    setTimeout(() => server.close(), 100);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  // 2. Register a fresh client for this login (matches Codex's per-session pattern).
  const clientId = await registerClient(host, redirectUri);

  // 3. Open browser to authorize.
  const authorizeUrl = new URL(`${host}/oauth/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("scope", "mcp");
  const authUrl = authorizeUrl.toString();
  console.error(`Opening browser to authorize:\n${authUrl}\n`);
  openBrowser(authUrl);

  // 4. Wait for callback (or timeout).
  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Login timed out. Retry with `emdee login`."));
    }, LOGIN_TIMEOUT_MS);
    server.on("close", () => {
      clearTimeout(timer);
      if (!capturedCode) return reject(new Error("Login was cancelled."));
      if (capturedState !== state) return reject(new Error("State mismatch — possible CSRF, aborted."));
      resolve(capturedCode);
    });
  });

  // 5. Exchange the code for an access token.
  const tokenRes = await fetch(`${host}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    }).toString(),
  });
  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => "");
    throw new Error(`token exchange failed: ${tokenRes.status} ${body}`);
  }
  const tokenBody = (await tokenRes.json()) as { access_token: string };

  const creds: Credentials = {
    access_token: tokenBody.access_token,
    client_id: clientId,
    host,
    saved_at: Date.now(),
  };
  await saveCreds(creds);
  return creds;
}

// Whoami — hits the new /api/whoami endpoint --------------------------------

export interface WhoamiPayload {
  namespace: string;
  email: string | null;
}

export async function whoami(creds: Credentials): Promise<WhoamiPayload> {
  const res = await fetch(`${creds.host}/api/whoami`, {
    headers: { Authorization: `Bearer ${creds.access_token}` },
  });
  if (res.status === 401) throw new NeedsLoginError();
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`whoami failed: ${res.status} ${body}`);
  }
  return (await res.json()) as WhoamiPayload;
}
