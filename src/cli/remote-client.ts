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
      // MCP streamable-HTTP transport requires BOTH content types in Accept
      // or it 406s with "Client must accept both application/json and
      // text/event-stream". We handle whichever shape the server picks below.
      "Accept": "application/json, text/event-stream",
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

  const body = await parseJsonRpc(res);
  if (body.error) throw new Error(`remote tool error: ${body.error.message}`);
  if (!body.result) throw new Error("remote call returned no result");
  return body.result;
}

// The MCP streamable-HTTP transport content-negotiates on the request Accept:
// when the client offers both JSON and SSE (as required — see 406 above),
// the server may reply with either. JSON we parse directly; SSE arrives as
// one or more `event: message\ndata: <json>\n\n` frames — for a single
// tools/call response we take the first `data:` payload.
async function parseJsonRpc(res: Response): Promise<JsonRpcResponse> {
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("text/event-stream")) {
    const text = await res.text();
    const dataLine = text.split(/\r?\n/).find((l) => l.startsWith("data:"));
    if (!dataLine) throw new Error(`remote call returned SSE with no data frame: ${text.slice(0, 200)}`);
    const payload = dataLine.slice("data:".length).trim();
    try {
      return JSON.parse(payload) as JsonRpcResponse;
    } catch (e) {
      throw new Error(`remote call SSE data frame is not valid JSON: ${(e as Error).message}`);
    }
  }
  return (await res.json()) as JsonRpcResponse;
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
