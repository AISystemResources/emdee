// SPRINT-178: OAuth scope taxonomy + enforcement helpers for the MCP
// surface. Cloud routines authenticate via /api/mcp with a Bearer token
// whose scope claim is stored in oauth_tokens.scope.
//
// Design goals (locked in the sprint spec):
// - Legacy `scope='mcp'` = full-access superuser. All 48 existing prod
//   tokens carry this, so backward compatibility is trivial.
// - Add narrow scopes as opt-in: docs:read, docs:write, docs:write:<prefix>,
//   tickets:<pillar>:create, tickets:<pillar>:update.
// - Enforcement layers: dispatcher-level classification (assertToolScope)
//   + per-path check inside write tools (assertPathWriteScope) + per-pillar
//   check inside ticket tools (hasScope + inline check).
// - Fail closed: unknown tools deny for scoped tokens (surfaces missing
//   classification as a hard error, not silent full-access).

import type { ToolContext } from "./tools/types";

export const LEGACY_FULL_ACCESS = "mcp";

// ── Scope parsing ──────────────────────────────────────────────────────

export function parseScopes(scopeString: string | undefined | null): string[] {
  if (!scopeString) return [];
  return scopeString.split(/\s+/).filter((s) => s.length > 0);
}

export function hasScope(scopeString: string | undefined | null, required: string): boolean {
  const scopes = parseScopes(scopeString);
  return scopes.includes(LEGACY_FULL_ACCESS) || scopes.includes(required);
}

/**
 * Returns the list of write-prefixes the token grants:
 * - `null` means unrestricted writes (mcp superuser OR bare `docs:write`)
 * - `[]` means the token has no write authority at all
 * - `["prefix1", "prefix2", ...]` means writes are allowed only under
 *   those decoded path prefixes
 */
export function grantedWritePrefixes(scopeString: string | undefined | null): string[] | null {
  const scopes = parseScopes(scopeString);
  if (scopes.includes(LEGACY_FULL_ACCESS)) return null;
  if (scopes.includes("docs:write")) return null;
  const prefixes: string[] = [];
  for (const s of scopes) {
    if (s.startsWith("docs:write:")) {
      const raw = s.slice("docs:write:".length);
      if (raw.length === 0) continue; // malformed empty-prefix scope: ignore
      try {
        prefixes.push(decodeURIComponent(raw));
      } catch {
        // malformed URL encoding: ignore this scope claim
      }
    }
  }
  return prefixes;
}

// ── Error type ─────────────────────────────────────────────────────────

export interface ScopeDeniedDetail {
  required: string;
  tool?: string;
  path?: string;
  pillar?: string;
}

export class ScopeDeniedError extends Error {
  readonly required: string;
  readonly tool?: string;
  readonly path?: string;
  readonly pillar?: string;

  constructor(detail: ScopeDeniedDetail) {
    const parts = [`required=${detail.required}`];
    if (detail.tool) parts.push(`tool=${detail.tool}`);
    if (detail.path) parts.push(`path=${detail.path}`);
    if (detail.pillar) parts.push(`pillar=${detail.pillar}`);
    super(`scope_denied: ${parts.join(" ")}`);
    this.name = "ScopeDeniedError";
    this.required = detail.required;
    this.tool = detail.tool;
    this.path = detail.path;
    this.pillar = detail.pillar;
  }
}

// ── Tool classification ────────────────────────────────────────────────
// Every MCP tool registered on /api/mcp must appear in EXACTLY ONE of
// these sets. The `assertAllToolsClassified` helper (exposed for tests)
// verifies this at test-time so a future tool addition without a scope
// classification surfaces as a hard failure, not a silent behavioural
// gap.

export const READ_TOOLS: ReadonlySet<string> = new Set([
  "batch_get_doc",
  "batch_get_summary",
  "distill_doc",
  "find_similar",
  "get_context",
  "get_doc",
  "get_image",
  "get_neighbors",
  "get_summary",
  "lint_doc",
  "lint_orphans",    // read by default; --fix requires elevated docs:write (enforced inside the tool)
  "lint_vault",
  "list_docs",
  "list_summary_drift",
  "list_tickets",
  "read_doc_section",
  "reconcile",       // per-path by default; --all requires elevated docs:write (enforced inside the tool)
  "search",
  "write_doc_preview", // non-destructive
]);

export const PATH_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "add_association",
  "append_doc",
  "append_section",
  "create_child",
  "delete_doc",
  "materialize_subgroup",
  "move_doc",
  "patch_preamble",
  "patch_section",
  "restore_doc",
  "split_doc",
  "trash_doc",
  "upload_image",
  "write_doc",
]);

export const BULK_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "lint_vault_autofix", // rewrites every doc that fires a fix rule
  "rename_doc",         // rewrites every doc containing [[old_title]]
  "rename_title",       // bulk wiki-link rewrite across the vault
]);

export const TICKET_TOOLS: ReadonlySet<string> = new Set([
  "create_ticket",
  "update_ticket",
]);

export const ALL_KNOWN_TOOLS: ReadonlySet<string> = new Set([
  ...READ_TOOLS,
  ...PATH_WRITE_TOOLS,
  ...BULK_WRITE_TOOLS,
  ...TICKET_TOOLS,
]);

// ── Dispatcher-level check ─────────────────────────────────────────────

function scopeOf(ctx: ToolContext): string {
  return ctx.mode === "cloud" ? ctx.scope ?? "" : LEGACY_FULL_ACCESS;
}

/**
 * Called at the top of the MCP dispatcher. Classifies the tool and
 * runs the appropriate scope check. Per-argument checks (path prefix,
 * ticket pillar) happen INSIDE the respective tools — this function
 * only enforces the coarse tool-category gate.
 *
 * Local-mode always passes (no scope concept for filesystem-backed
 * sessions).
 */
export function assertToolScope(ctx: ToolContext, toolName: string): void {
  if (ctx.mode !== "cloud") return;
  const scope = scopeOf(ctx);
  if (hasScope(scope, LEGACY_FULL_ACCESS)) return; // superuser short-circuit

  if (READ_TOOLS.has(toolName)) {
    if (!hasScope(scope, "docs:read")) {
      throw new ScopeDeniedError({ required: "docs:read", tool: toolName });
    }
    return;
  }

  if (PATH_WRITE_TOOLS.has(toolName)) {
    // Requires SOME write authority (bare docs:write or docs:write:<prefix>).
    // Per-path check happens inside the tool.
    const prefixes = grantedWritePrefixes(scope);
    if (prefixes === null) return; // unrestricted docs:write
    if (prefixes.length === 0) {
      throw new ScopeDeniedError({ required: "docs:write", tool: toolName });
    }
    return;
  }

  if (BULK_WRITE_TOOLS.has(toolName)) {
    // Bulk tools rewrite arbitrary docs across the vault. Prefix-only
    // tokens can't do this — the tool's blast radius exceeds their
    // grant. Require unrestricted docs:write.
    if (!hasScope(scope, "docs:write")) {
      throw new ScopeDeniedError({
        required: "docs:write (bulk operation — prefix-only tokens denied)",
        tool: toolName,
      });
    }
    return;
  }

  if (TICKET_TOOLS.has(toolName)) {
    // Pillar-specific check happens inside the tool (needs args.pillar
    // for create, needs a ticket-fetch for update).
    return;
  }

  // Unknown tool — fail closed. If a future PR adds a tool without
  // classifying it here, scoped tokens surface the miss as
  // scope_denied. Tests assert every registered tool is classified.
  throw new ScopeDeniedError({
    required: "unclassified_tool (add to READ_TOOLS/PATH_WRITE_TOOLS/BULK_WRITE_TOOLS/TICKET_TOOLS in scopes.ts)",
    tool: toolName,
  });
}

// ── Tool-friendly error shape ──────────────────────────────────────────
//
// Tools return `{ content: [{ type: "text", text: "..." }] }` (the MCP
// tool-result envelope). To keep scope-denial responses consistent
// across all tools without repeating the shape-building boilerplate,
// these helpers return the fully-formed error envelope on denial or
// null on success. Each tool that guards on scope calls:
//
//   const err = scopeCheckPathWrite(ctx, path);
//   if (err) return err;
//
// This mirrors how each tool already handles validation errors (early
// return with a shape-formed error result).

function scopeDeniedResult(detail: ScopeDeniedDetail): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        error: "scope_denied",
        required: detail.required,
        tool: detail.tool,
        path: detail.path,
        pillar: detail.pillar,
      }),
    }],
  };
}

/**
 * Guard version of {@link assertPathWriteScope} that returns a formatted
 * tool-result envelope on denial (for `return err;` in tool handlers)
 * or `null` if the write is authorized. Prefer this inside tools;
 * `assertPathWriteScope` is for internal composition.
 */
export function scopeCheckPathWrite(ctx: ToolContext, path: string): { content: Array<{ type: "text"; text: string }> } | null {
  try {
    assertPathWriteScope(ctx, path);
    return null;
  } catch (e) {
    if (e instanceof ScopeDeniedError) return scopeDeniedResult(e);
    throw e;
  }
}

/**
 * Guard version of {@link assertUnrestrictedDocsWrite}. Used inside
 * tools whose args elevate them to a bulk operation (`reconcile --all`,
 * `lint_orphans --fix`).
 */
export function scopeCheckUnrestrictedWrite(ctx: ToolContext, tool: string): { content: Array<{ type: "text"; text: string }> } | null {
  try {
    assertUnrestrictedDocsWrite(ctx, tool);
    return null;
  } catch (e) {
    if (e instanceof ScopeDeniedError) return scopeDeniedResult(e);
    throw e;
  }
}

// ── Per-path check (called inside write tools) ─────────────────────────

/**
 * Called inside every PATH_WRITE_TOOLS handler at the top, once per
 * referenced path. Throws ScopeDeniedError when the token has
 * prefix-scoped write authority that doesn't include this path.
 *
 * mcp / bare docs:write short-circuit (return without check). Local
 * mode also passes unconditionally.
 */
export function assertPathWriteScope(ctx: ToolContext, path: string): void {
  if (ctx.mode !== "cloud") return;
  const prefixes = grantedWritePrefixes(scopeOf(ctx));
  if (prefixes === null) return; // unrestricted
  if (prefixes.some((p) => path.startsWith(p))) return;
  throw new ScopeDeniedError({
    required: prefixes.length > 0
      ? `docs:write:<prefix matching ${path}>`
      : "docs:write",
    path,
  });
}

/**
 * Called inside tools that support both per-path and elevated modes
 * (e.g. `reconcile --all`, `lint_orphans --fix`). Refuses prefix-only
 * tokens; requires unrestricted docs:write.
 */
export function assertUnrestrictedDocsWrite(ctx: ToolContext, tool: string): void {
  if (ctx.mode !== "cloud") return;
  if (!hasScope(scopeOf(ctx), "docs:write")) {
    throw new ScopeDeniedError({
      required: "docs:write (elevated operation — prefix-only tokens denied)",
      tool,
    });
  }
}

// ── Consent-UI helpers ─────────────────────────────────────────────────

/**
 * Plain-English description per known scope claim. Used by
 * /oauth/authorize to render a human-readable consent page.
 *
 * For dynamic scopes (docs:write:<prefix>, tickets:<pillar>:*), the
 * describeScope() function below composes the description at runtime.
 */
export const SCOPE_DESCRIPTIONS: Record<string, string> = {
  mcp: "Full access — read + write across your entire vault, all tickets, every tool. Approve only for trusted local CLIs, not cloud routines.",
  "docs:read": "Read every doc in your vault (title, summary, body, sections).",
  "docs:write": "Write to any doc in your vault (create, edit, move, delete). Unrestricted.",
};

export interface ScopeDescription {
  scope: string;         // the raw scope claim
  label: string;         // plain-English description
  dangerous: boolean;    // render with visual warning
  known: boolean;        // matches a known scope pattern
}

export function describeScope(scope: string): ScopeDescription {
  // Static exact match
  if (SCOPE_DESCRIPTIONS[scope]) {
    const dangerous = scope === LEGACY_FULL_ACCESS || scope === "docs:write";
    return { scope, label: SCOPE_DESCRIPTIONS[scope], dangerous, known: true };
  }

  // docs:write:<url-encoded-prefix>
  if (scope.startsWith("docs:write:")) {
    const raw = scope.slice("docs:write:".length);
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return { scope, label: `Malformed write-scope claim: ${scope}`, dangerous: true, known: false };
    }
    return {
      scope,
      label: `Write to docs under path prefix "${decoded}" (create, edit, delete within this subtree only).`,
      dangerous: false,
      known: true,
    };
  }

  // tickets:<pillar>:create
  const ticketCreate = /^tickets:([a-z]+):create$/.exec(scope);
  if (ticketCreate) {
    return {
      scope,
      label: `Create tickets on the ${ticketCreate[1].toUpperCase()} pillar.`,
      dangerous: false,
      known: true,
    };
  }

  // tickets:<pillar>:update
  const ticketUpdate = /^tickets:([a-z]+):update$/.exec(scope);
  if (ticketUpdate) {
    return {
      scope,
      label: `Update tickets on the ${ticketUpdate[1].toUpperCase()} pillar (your own tickets only, namespace-scoped).`,
      dangerous: false,
      known: true,
    };
  }

  // Unknown / unrecognised — surface it so user knows something's off.
  return {
    scope,
    label: `Unrecognised scope: "${scope}" — this claim will NOT grant any access. Contact the requester if you expected something.`,
    dangerous: true,
    known: false,
  };
}

// ── Test-time invariant helper ─────────────────────────────────────────

/**
 * Verify every registered MCP tool appears in exactly one classification
 * set. Called from e2e tests to catch missing classifications at
 * build-time rather than in production.
 */
export function assertAllToolsClassified(registeredTools: readonly string[]): void {
  const missing: string[] = [];
  const doubles: string[] = [];
  for (const tool of registeredTools) {
    const in_read = READ_TOOLS.has(tool);
    const in_path = PATH_WRITE_TOOLS.has(tool);
    const in_bulk = BULK_WRITE_TOOLS.has(tool);
    const in_ticket = TICKET_TOOLS.has(tool);
    const count = Number(in_read) + Number(in_path) + Number(in_bulk) + Number(in_ticket);
    if (count === 0) missing.push(tool);
    if (count > 1) doubles.push(tool);
  }
  if (missing.length > 0 || doubles.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing classification: ${missing.join(", ")}`);
    if (doubles.length > 0) parts.push(`double-classified: ${doubles.join(", ")}`);
    throw new Error(`scopes.ts drift: ${parts.join(" | ")}`);
  }
}
