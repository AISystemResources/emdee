// SPRINT-092: strict argument validation for write-side MCP tools.
//
// The MCP SDK (@modelcontextprotocol/sdk/dist/esm/server/index.js) validates
// only the outer CallToolRequestSchema — individual tool `arguments` are
// passed through as Record<string, unknown> without JSON-Schema enforcement.
// Adding `additionalProperties: false` to inputSchema is documentation only.
//
// This helper closes the gap at each tool's entry point: unknown parameter
// names return a loud error instead of being silently dropped, and required
// parameters must actually be present (not just default to "" when missing).

export interface ArgSpec {
  allowed: readonly string[];
  required?: readonly string[];
}

export type ArgValidationError =
  | { error: "unknown_arguments"; unknown: string[]; allowed: string[] }
  | { error: "missing_required"; missing: string[]; allowed: string[] };

export function validateArgs(
  args: Record<string, unknown>,
  spec: ArgSpec,
): ArgValidationError | null {
  const allowedSet = new Set(spec.allowed);
  const unknown = Object.keys(args).filter((k) => !allowedSet.has(k));
  if (unknown.length > 0) {
    return { error: "unknown_arguments", unknown, allowed: [...spec.allowed] };
  }
  const required = spec.required ?? [];
  const missing = required.filter((k) => !(k in args));
  if (missing.length > 0) {
    return { error: "missing_required", missing, allowed: [...spec.allowed] };
  }
  return null;
}
