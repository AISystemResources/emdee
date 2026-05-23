"use client";
import { useEffect, useRef } from "react";

export type ActionKind =
  | "read"
  | "write"
  | "delete"
  | "rename"
  | "search"
  | "lint"
  | "other";

export interface McpActivityEvent {
  id: string;
  tool_name: string;
  doc_path: string | null;
  action_kind: ActionKind;
  clerk_id: string;
  created_at: string;
}

/**
 * Subscribe to MCP tool-call events for a namespace. Mirrors the SSE
 * half of useDocsChanged — the server route /api/mcp-activity polls
 * the mcp_activity table (service role) and forwards rows as SSE.
 *
 * The hook is a no-op for the "public" namespace (no per-vault auth).
 * EventSource auto-reconnects when the server-side 50s stream cap
 * expires, so events keep flowing without extra plumbing.
 */
export function useMcpActivity(
  namespace: string,
  onEvent: (e: McpActivityEvent) => void,
): void {
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    if (!namespace || namespace === "public") return;
    const es = new EventSource(
      `/api/mcp-activity?ns=${encodeURIComponent(namespace)}`,
    );
    es.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data) as McpActivityEvent;
        onEventRef.current(parsed);
      } catch {
        // Malformed payload — drop it. Pulse fidelity isn't worth a throw.
      }
    };
    return () => {
      es.close();
    };
  }, [namespace]);
}
