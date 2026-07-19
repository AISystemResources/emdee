// SPRINT-091: thin wrapper around POST /api/mcp for CLI --remote commands.
//
// Every call routes through the same JSON-RPC surface claude.ai uses, so we
// inherit auth + rate limits + logging for free. The MCP SDK's tool response
// envelope (`content: [{type: "text", text: "..."}]`) unwraps here — CLI
// verbs receive the already-parsed JSON so they can print it plain.

import { loadCreds, NeedsLoginError, type Credentials } from "./auth";
import { randomUUID } from "node:crypto";

export interface RemoteResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  [k: string]: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string;
  result?: RemoteResult;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Invoke an MCP tool over HTTP against the user's authenticated vault.
 * Throws NeedsLoginError if no creds or token is rejected.
 */
export async function callTool(
  name: string,
  args: Record<string, unknown>,
  credsOverride?: Credentials,
): Promise<RemoteResult> {
  const creds = credsOverride ?? (await loadCreds());
  if (!creds) throw new NeedsLoginError();

  const res = await fetch(`${creds.host}/api/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      Authorization: `Bearer ${creds.access_token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });

  if (res.status === 401) throw new NeedsLoginError("Access token was rejected. Run `emdee login` again.");
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`remote call failed: ${res.status} ${body}`);
  }

  const body = (await res.json()) as JsonRpcResponse;
  if (body.error) throw new Error(`remote tool error: ${body.error.message}`);
  if (!body.result) throw new Error("remote call returned no result");
  return body.result;
}

/**
 * Convenience: unwrap the MCP text envelope back to a string. Tools that
 * return JSON encode it inside `content[0].text`; tools that return plain
 * text put it there directly. Callers decide whether to JSON.parse.
 */
export function unwrapText(result: RemoteResult): string {
  const first = result.content?.[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    return JSON.stringify(result);
  }
  return first.text;
}
