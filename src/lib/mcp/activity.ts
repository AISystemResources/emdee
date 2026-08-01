import { adminClient } from "../supabase/admin";

export type ActionKind =
  | "read"
  | "write"
  | "delete"
  | "rename"
  | "search"
  | "lint"
  | "other";

export interface ActivityRouting {
  /** Tool name as exposed by the MCP server. */
  tool_name: string;
  /** Classification for the visual pulse colour mapping. */
  action_kind: ActionKind;
  /** Extract the focal doc path from the tool's args. Return null for
   *  tools without a focal (search, list_docs). */
  doc_path: (args: unknown) => string | null;
  /** Optional: extract supplementary info to store in args_summary jsonb. */
  args_summary?: (args: unknown) => Record<string, unknown>;
}

function asRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" ? (args as Record<string, unknown>) : {};
}

function strField(args: unknown, key: string): string | null {
  const v = asRecord(args)[key];
  return typeof v === "string" ? v : null;
}

export const ACTIVITY_ROUTING: Record<string, ActivityRouting> = {
  // ── Reads ───────────────────────────────────────────────────────────────
  get_doc: {
    tool_name: "get_doc",
    action_kind: "read",
    doc_path: (a) => strField(a, "path"),
  },
  get_summary: {
    tool_name: "get_summary",
    action_kind: "read",
    doc_path: (a) => strField(a, "path"),
  },
  get_neighbors: {
    tool_name: "get_neighbors",
    action_kind: "read",
    doc_path: (a) => strField(a, "path"),
  },
  get_context: {
    tool_name: "get_context",
    action_kind: "read",
    doc_path: (a) => strField(a, "path"),
    args_summary: (a) => {
      const r = asRecord(a);
      const out: Record<string, unknown> = {};
      if (typeof r.hops === "number") out.hops = r.hops;
      if (typeof r.budget_tokens === "number") out.budget_tokens = r.budget_tokens;
      return out;
    },
  },
  read_doc_section: {
    tool_name: "read_doc_section",
    action_kind: "read",
    doc_path: (a) => strField(a, "path"),
    args_summary: (a) => {
      const r = asRecord(a);
      const out: Record<string, unknown> = {};
      if (typeof r.heading === "string") out.heading = r.heading;
      if (typeof r.section_id === "string") out.section_id = r.section_id;
      return out;
    },
  },
  // ── Searches ────────────────────────────────────────────────────────────
  list_docs: {
    tool_name: "list_docs",
    action_kind: "search",
    doc_path: () => null,
  },
  search: {
    tool_name: "search",
    action_kind: "search",
    doc_path: () => null,
    args_summary: (a) => {
      const r = asRecord(a);
      const out: Record<string, unknown> = {};
      if (typeof r.query === "string") out.query = r.query;
      if (typeof r.limit === "number") out.limit = r.limit;
      return out;
    },
  },
  // ── Writes ──────────────────────────────────────────────────────────────
  write_doc: {
    tool_name: "write_doc",
    action_kind: "write",
    doc_path: (a) => strField(a, "path"),
  },
  // Preview is non-destructive — treat as a read.
  write_doc_preview: {
    tool_name: "write_doc_preview",
    action_kind: "read",
    doc_path: (a) => strField(a, "path"),
  },
  append_doc: {
    tool_name: "append_doc",
    action_kind: "write",
    doc_path: (a) => strField(a, "path"),
  },
  append_section: {
    tool_name: "append_section",
    action_kind: "write",
    doc_path: (a) => strField(a, "path"),
    args_summary: (a) => {
      const r = asRecord(a);
      return typeof r.heading === "string" ? { heading: r.heading } : {};
    },
  },
  patch_section: {
    tool_name: "patch_section",
    action_kind: "write",
    doc_path: (a) => strField(a, "path"),
    args_summary: (a) => {
      const r = asRecord(a);
      return typeof r.heading === "string" ? { heading: r.heading } : {};
    },
  },
  patch_preamble: {
    tool_name: "patch_preamble",
    action_kind: "write",
    doc_path: (a) => strField(a, "path"),
  },
  // ── Deletes / Renames ───────────────────────────────────────────────────
  delete_doc: {
    tool_name: "delete_doc",
    action_kind: "delete",
    doc_path: (a) => strField(a, "path"),
  },
  rename_doc: {
    tool_name: "rename_doc",
    action_kind: "rename",
    doc_path: (a) => strField(a, "new_path") ?? strField(a, "old_path"),
    args_summary: (a) => {
      const r = asRecord(a);
      return typeof r.old_path === "string" ? { old_path: r.old_path } : {};
    },
  },
  // ── Compound atomic writes ──────────────────────────────────────────────
  split_doc: {
    tool_name: "split_doc",
    action_kind: "write",
    doc_path: (a) => strField(a, "source_path"),
    args_summary: (a) => {
      const r = asRecord(a);
      const extracts = Array.isArray(r.extracts) ? r.extracts.length : undefined;
      return extracts !== undefined ? { extracts } : {};
    },
  },
  distill_doc: {
    tool_name: "distill_doc",
    action_kind: "read",
    doc_path: (a) => strField(a, "path"),
  },
  materialize_subgroup: {
    tool_name: "materialize_subgroup",
    action_kind: "write",
    doc_path: (a) => strField(a, "source_path"),
    args_summary: (a) => {
      const r = asRecord(a);
      return typeof r.subgroup_heading === "string"
        ? { subgroup_heading: r.subgroup_heading }
        : {};
    },
  },
  // ── Lint / quality ──────────────────────────────────────────────────────
  lint_doc: {
    tool_name: "lint_doc",
    action_kind: "lint",
    doc_path: (a) => strField(a, "path"),
  },
  // ── Compound atomic writes (SPRINT-019) ─────────────────────────────────
  create_child: {
    tool_name: "create_child",
    action_kind: "write",
    doc_path: (a) => strField(a, "parent_path"),
    args_summary: (a) => {
      const r = asRecord(a);
      const out: Record<string, unknown> = {};
      if (typeof r.title === "string") out.title = r.title;
      if (typeof r.child_path === "string") out.child_path = r.child_path;
      return out;
    },
  },
  add_association: {
    tool_name: "add_association",
    action_kind: "write",
    doc_path: (a) => strField(a, "a_path"),
    args_summary: (a) => {
      const r = asRecord(a);
      return typeof r.b_path === "string" ? { b_path: r.b_path } : {};
    },
  },
  // ── Tickets (SPRINT-173) ────────────────────────────────────────────────
  // Tickets aren't vault docs — doc_path stays null; args_summary carries
  // the pillar/type/status/priority tags so the activity pulse still
  // conveys who did what.
  create_ticket: {
    tool_name: "create_ticket",
    action_kind: "write",
    doc_path: () => null,
    args_summary: (a) => {
      const r = asRecord(a);
      const out: Record<string, unknown> = {};
      if (typeof r.pillar === "string") out.pillar = r.pillar;
      if (typeof r.type === "string") out.type = r.type;
      if (typeof r.priority === "string") out.priority = r.priority;
      return out;
    },
  },
  list_tickets: {
    tool_name: "list_tickets",
    action_kind: "read",
    doc_path: () => null,
    args_summary: (a) => {
      const r = asRecord(a);
      const out: Record<string, unknown> = {};
      if (typeof r.pillar === "string") out.pillar = r.pillar;
      if (typeof r.status === "string") out.status = r.status;
      return out;
    },
  },
  update_ticket: {
    tool_name: "update_ticket",
    action_kind: "write",
    doc_path: () => null,
    args_summary: (a) => {
      const r = asRecord(a);
      const out: Record<string, unknown> = {};
      if (typeof r.id === "string") out.id = r.id;
      if (typeof r.status === "string") out.status = r.status;
      if (typeof r.priority === "string") out.priority = r.priority;
      return out;
    },
  },
};

/**
 * Fire-and-forget insert. Logging failure must never block the tool call,
 * so we swallow errors with a console.warn. If the path resolves to a
 * shared doc (__shared__/<owner>/...), the row is logged against the
 * OWNER'S namespace so the owner sees the pulse — the caller's clerk_id
 * is still recorded so they can tell self-vs-other.
 *
 * Caller must guard on ctx.mode === "cloud" before invoking — local-dev
 * stdio sessions have no clerk_id and aren't worth logging.
 */
export async function logMcpActivity(
  callerNamespace: string,
  clerkId: string,
  toolName: string,
  args: unknown,
): Promise<void> {
  const routing = ACTIVITY_ROUTING[toolName];
  if (!routing) return; // unknown tool — don't log

  const rawPath = routing.doc_path(args);
  // Resolve shared-doc owner namespace.
  let targetNs = callerNamespace;
  let docPath = rawPath;
  if (rawPath && rawPath.startsWith("__shared__/")) {
    const parts = rawPath.split("/");
    if (parts.length >= 3) {
      targetNs = parts[1]; // <owner_id>
      docPath = parts.slice(2).join("/");
    }
  }

  let argsSummary: Record<string, unknown> | undefined;
  if (routing.args_summary) {
    const s = routing.args_summary(args);
    if (s && Object.keys(s).length > 0) argsSummary = s;
  }

  try {
    const { error } = await adminClient().from("mcp_activity").insert({
      namespace: targetNs,
      clerk_id: clerkId,
      tool_name: routing.tool_name,
      doc_path: docPath,
      action_kind: routing.action_kind,
      args_summary: argsSummary,
    });
    if (error) console.warn("[mcp_activity] insert failed:", error.message);
  } catch (e) {
    console.warn("[mcp_activity] insert threw:", (e as Error).message);
  }
}
