// SPRINT-096 regression: CLI --remote transport.
//
// History (all in-flight the same session):
//   - 0.3.0 shipped with `Accept: application/json, text/event-stream` and
//     tried to `res.json()` the response. The MCP streamable-HTTP server
//     chose SSE (both offered → server picks) and JSON.parse crashed on
//     `event: message...`.
//   - 0.3.1 tried to fix by dropping SSE from Accept. The transport requires
//     BOTH content types and returned 406 Not Acceptable. Broken differently.
//   - 0.3.2 (this fix): keep the dual Accept as the transport demands, but
//     parse the response based on Content-Type — JSON directly, SSE frame
//     unwrapped to its `data:` payload.
//
// This spec locks all three sides:
//   1. Unit: dual-Accept request sent AND JSON response parses.
//   2. Unit: dual-Accept request sent AND SSE response parses (the frame the
//      real server actually sends).
//   3. Server integration: POST /api/mcp with JSON-only Accept 406s. This is
//      the constraint that broke 0.3.1 — if the server ever gets lenient we
//      can retire the SSE parsing; until then the client must play along.

import { test, expect } from "@playwright/test";
import { callTool } from "../../src/cli/remote-client";

const fakeCreds = {
  access_token: "test-token",
  client_id: "test-client",
  host: "https://example.invalid",
  saved_at: 0,
};

test.describe("CLI --remote transport (SPRINT-096 regression)", () => {
  test("callTool sends dual Accept and parses a JSON response", async () => {
    let captured: { headers?: Record<string, string>; body?: { id: string } } = {};
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      captured = {
        headers: init.headers as Record<string, string>,
        body: JSON.parse(init.body as string) as { id: string },
      };
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: captured.body!.id,
          result: { content: [{ type: "text", text: "ok" }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const result = await callTool("get_summary", { path: "EMDEE.md" }, fakeCreds);
      expect(captured.headers?.Accept, "Accept includes JSON").toContain("application/json");
      expect(captured.headers?.Accept, "Accept includes SSE (transport requires it)").toContain(
        "text/event-stream",
      );
      expect(captured.headers?.Authorization).toBe("Bearer test-token");
      expect(result).toMatchObject({ content: [{ type: "text", text: "ok" }] });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("callTool unwraps an SSE data frame — the shape the real MCP server sends", async () => {
    const rpcPayload = {
      jsonrpc: "2.0",
      id: "abc",
      result: { content: [{ type: "text", text: "from sse" }] },
    };
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(`event: message\ndata: ${JSON.stringify(rpcPayload)}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as typeof fetch;
    try {
      const result = await callTool("get_summary", { path: "x" }, fakeCreds);
      expect(result).toMatchObject({ content: [{ type: "text", text: "from sse" }] });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  // Note: we don't include a server-side test for the transport's
  // 406-on-JSON-only behaviour because /api/mcp's Clerk auth check fires
  // first for unauthenticated requests, so the transport's content
  // negotiation is unreachable without a real token. The two unit tests
  // above cover the CLI-side regression directly — that's the surface
  // that broke twice in one session.
});
