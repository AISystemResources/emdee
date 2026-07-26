import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { clerkIdFromOAuthToken } from "@/src/lib/supabase/oauth";
import { SupabaseStorage } from "@/src/lib/storage/SupabaseStorage";
import type { ToolContext } from "@/src/lib/mcp/tools/types";
import {
  listDocs, listSummaryDrift, getSummary, getNeighbors, getContext, getDoc, readDocSection, search,
  appendSection, patchSection, writeDocPreview, writeDoc, deleteDoc, splitDoc, renameDoc, renameTitle, patchPreamble, appendDoc,
  lintDoc, lintVault, lintVaultAutofix, reconcile, lintOrphans, batchGetSummary, batchGetDoc, findSimilar, distillDoc, materializeSubgroup, createChild, addAssociation, getImage, moveDoc, trashDoc, restoreDoc,
} from "@/src/lib/mcp/tools/index";
import { logMcpActivity } from "@/src/lib/mcp/activity";
import pkg from "@/package.json";

export const dynamic = "force-dynamic";

// Browser-side MCP clients (claude.ai's tool widget) hit this endpoint from a
// different origin, so every response needs CORS headers and OPTIONS preflights
// must succeed before the real request is sent.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
  "Access-Control-Expose-Headers": "mcp-session-id, www-authenticate",
  "Access-Control-Max-Age": "86400",
};

function withCors(response: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) response.headers.set(k, v);
  return response;
}

function bearerChallenge(origin: string): Response {
  return withCors(new Response(null, {
    status: 401,
    headers: {
      "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    },
  }));
}

function buildMcpServer(ctx: ToolContext): Server {
  const server = new Server(
    { name: "emdee", version: pkg.version },
    {
      capabilities: { tools: {} },
      instructions: `You are working inside an Emdee vault — a plain-markdown knowledge graph.

BEFORE writing or editing any doc:
1. Call get_doc("INFO.md", full=true) to load vault conventions — get_doc now returns the light envelope by default; pass full=true when you actually need the body.
2. Use patch_section for incremental edits — never write_doc for single-section changes.

Read-side defaults (SPRINT-018):
- get_doc returns title + summary + preamble + section headings only. Pass full=true for the body.
- get_context is the multi-hop big sibling of get_neighbors — returns the focal + neighbourhood within a token budget. Prefer it over chaining get_doc + get_neighbors when you need a coherent local view.

Write-side atomics (SPRINT-019):
- create_child(parent_path, title, body?, summary?) — atomic write + parent patch. Use this instead of write_doc + patch_section for adding child nodes.
- add_association(a_path, b_path, label?) — atomic two-sided assoc patch. Hard-refuses sibling or hierarchy-duplicating pairs. Use this instead of two patch_section calls for cross-tree links.
- Every write tool accepts gate_on_warnings: [lint_codes]. Recommended for routine writes: ["multiple_child_of", "associate_duplicates_hierarchy", "sibling_assoc_redundant"]. Gating refuses the write and returns { error: "lint_gate_failed", fixes: [{ line, fix_suggestion }] } so you can correct and retry inside the same turn.
- get_doc returns a stable section_id per H2. Pass section_id to patch_section / append_section instead of heading whenever heading text might drift.

Key conventions:
- Every doc starts with one H1 + one > blockquote summary immediately below it.
- Sprints: Child of [[PROJECT — BUILD]] if active/spec, Child of [[PROJECT — LOGS]] if shipped.

Edge discipline (lint_doc warns on violations):
- One parent per doc: \`## Child of\` should have exactly one bullet. Multiple parents → demote the secondary ones to \`## Associated with\`.
- No sibling associations: docs that share a parent are already related through it. \`## Associated with\` is for cross-tree connections (project↔person, sprint↔learning), not for linking two day-notes under the same event.
- Reciprocal edges: if A's \`## Parent of\` lists [[B]], B's \`## Child of\` must list [[A]]. One-sided edges fire asymmetric_parent_edge / asymmetric_child_edge.
- Sibling order is derived from the parent's \`## Parent of\` bullet order — never declare \`[[next-node]]\` / \`[[prev-node]]\` edges in markdown. \`get_neighbors\` returns \`prev_sibling\` / \`next_sibling\` automatically.

Shared docs:
- Paths starting with "__shared__/<owner_id>/" are docs another user has
  shared into this vault. They appear in list_docs and are readable via
  get_doc / get_summary / search, but every write tool (write_doc,
  patch_section, append_section, delete_doc, split_doc) will refuse them.
  If you need to edit one, ask the user to talk to the owner.`,
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "list_docs", description: "Enumerate every doc as {path, title, summary}. `format:\"compact\"` drops summary (~60% cheaper). `format:\"text\"` is newline-delimited paths only (~5× cheaper).", inputSchema: { type: "object", properties: { format: { type: "string", enum: ["json", "compact", "text"] } } }, annotations: { readOnlyHint: true, openWorldHint: false } },
      { name: "list_summary_drift", description: "SPRINT-081: return paths whose body has drifted since the summary was last authored. Cloud mode reads persisted hashes; local mode returns every doc. Response is minimal — path + current summary + reason. Entry point to the summariser workflow. Pass `format: \"text\"` for newline-delimited paths only.", inputSchema: { type: "object", properties: { prefix: { type: "string" }, limit: { type: "number", description: "Max candidates. Default 20." }, offset: { type: "number", description: "Skip N. Default 0." }, format: { type: "string", enum: ["json", "text"] } } }, annotations: { readOnlyHint: true, openWorldHint: false } },
      { name: "get_summary", description: "Return {path, title, summary} for one doc. Pass `format: \"text\"` for the bare summary line only.", inputSchema: { type: "object", properties: { path: { type: "string" }, format: { type: "string", enum: ["json", "text"] } }, required: ["path"] }, annotations: { readOnlyHint: true, openWorldHint: false } },
      { name: "get_neighbors", description: "Return the doc plus its 1-hop neighborhood.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, annotations: { readOnlyHint: true, openWorldHint: false } },
      { name: "get_context", description: "Return the focal doc plus its multi-hop neighbourhood within a token budget. Focal + 1-hop neighbours get full bodies (when include_full); deeper hops get summary only. Response includes `doc_content_hash` of the focal. Pass `expected_content_hash` from a prior call to short-circuit when the focal hasn't changed (returns `{ unchanged: true, path, doc_content_hash }`). Note: neighbourhood-only changes don't bust this; refetch unconditionally when chasing structural drift.", inputSchema: { type: "object", properties: { path: { type: "string" }, hops: { type: "number", description: "Max BFS depth, 1–3. Default 2." }, budget_tokens: { type: "number", description: "Rough token cap (chars÷4). Default 8000." }, include_full: { type: "boolean", description: "Inline focal + hop-1 bodies. Default true." }, include_associates: { type: "boolean", description: "Include assoc edges in the walk. Default true." }, expected_content_hash: { type: "string", description: "Hash from a prior get_context. If matches focal doc, returns { unchanged: true }." } }, required: ["path"] }, annotations: { readOnlyHint: true, openWorldHint: false } },
      { name: "get_doc", description: "Doc envelope (title + summary + preamble + section headings + hashes). `full=true` for body. `expected_content_hash` short-circuits to `{unchanged:true}` when doc unchanged. `format:\"text\"` returns bare markdown (~3× cheaper than JSON).", inputSchema: { type: "object", properties: { path: { type: "string" }, full: { type: "boolean", description: "Include the full markdown content. Default false — light envelope only." }, expected_content_hash: { type: "string", description: "Hash from a prior get_doc response. If matches current doc, returns { unchanged: true }." }, format: { type: "string", enum: ["json", "text"], description: "Response shape. Default `json`. `text` = bare markdown, no envelope." } }, required: ["path"] }, annotations: { readOnlyHint: true, openWorldHint: false } },
      { name: "read_doc_section", description: "Read one H2 section's body — cheaper than get_doc(full=true). Provide `heading` or `section_id` (preferred; from get_doc.sections[].id). `expected_content_hash` short-circuits to `{unchanged:true}`.", inputSchema: { type: "object", properties: { path: { type: "string" }, heading: { type: "string" }, section_id: { type: "string", description: "Preferred lookup key from get_doc.sections[].id." }, expected_content_hash: { type: "string", description: "Hash from a prior read. If matches, returns { unchanged: true }." } }, required: ["path"] }, annotations: { readOnlyHint: true, openWorldHint: false } },
      { name: "search", description: "Case-insensitive search over titles, summaries, and content. `format:\"compact\"` returns just {path, title} — ~80% cheaper for enumerate-then-drill workflows.", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" }, format: { type: "string", enum: ["json", "compact"] } }, required: ["query"] }, annotations: { readOnlyHint: true, openWorldHint: false } },
      { name: "append_section", description: "Append markdown to end of an H2 section (not doc end — use append_doc for chronological notes). Provide `heading` or `section_id` (preferred; from get_doc.sections[].id). `create_if_missing` scaffolds the section. `gate_on_warnings` hard-blocks on lint codes.", inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string" }, heading: { type: "string" }, section_id: { type: "string", description: "Preferred lookup key from get_doc.sections[].id." }, body: { type: "string" }, create_if_missing: { type: "boolean" }, gate_on_warnings: { type: "array", items: { type: "string" }, description: "Lint codes to hard-block on. Default []." } }, required: ["path", "body"] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
      { name: "append_doc", description: "Append content to the very end of a doc (after every existing section). For chronological note-taking — LOGS, daily notes, anywhere new content should land at the bottom of the page regardless of section structure. The body may include its own `##` headings to introduce new sections at the end. Pass `gate_on_warnings: [\"code\", ...]` to hard-block the write when any of those lint codes would fire on the proposed content.", inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string" }, body: { type: "string" }, gate_on_warnings: { type: "array", items: { type: "string" }, description: "Lint codes to hard-block on. Default []." } }, required: ["path", "body"] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
      { name: "lint_doc", description: "Audit a doc for quality defects. Returns warnings (missing preamble blockquote, inline wiki-link mentions ≥3× without a declared edge) and structural info. Signal, not gate — never throws on a 'bad' doc.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, annotations: { readOnlyHint: true, openWorldHint: false } },
      { name: "lint_vault", description: "SPRINT-101: batch-lint the caller's entire vault in one call. Runs every per-doc + cross-doc rule against the in-memory index (no per-doc round trips). Returns { scanned, with_warnings, warnings_total, warnings_by_code, docs: [{path, warnings[]}] } with docs sorted by warning count descending. Pass `prefix` to scope to a subtree, `limit` to cap the returned punch list.", inputSchema: { type: "object", additionalProperties: false, properties: { prefix: { type: "string", description: "Optional path prefix filter." }, limit: { type: "number", description: "Optional max docs in the response punch list. Default: all." } } }, annotations: { readOnlyHint: true, openWorldHint: false } },
      { name: "reconcile", description: "SPRINT-108 Fix 3: user-facing repair verb for doc_edges drift. Two modes: pass `path` for per-doc reconcile (deletes all doc_edges rows touching the doc, re-runs syncDocEdges from current Storage content), OR pass `all: true` for a full-namespace rebuild (wipes and rebuilds every doc_edges row from markdown truth via backfillNamespace). Use when sidebar shows orphans, or after batch operations that left the graph inconsistent. Cloud-only. Returns { ok, mode, path?, edges_deleted?, docs_scanned?, edges_written? }.", inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string", description: "Doc path to reconcile. Either this or `all` must be set." }, all: { type: "boolean", description: "Full-namespace rebuild. Either this or `path` must be set." } } }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
      { name: "lint_orphans", description: "Detect docs with no incoming hierarchy edge (sidebar-root orphans). Classifies: data_layer_drift (auto-fixable), markdown_drift (unresolvable wiki-link, needs human), structural_orphan (no `## Child of`). `fix:true` runs per-doc reconcile on data-layer cases. Cloud-only.", inputSchema: { type: "object", additionalProperties: false, properties: { fix: { type: "boolean", description: "Auto-fix data_layer_drift orphans by running per-doc reconcile. Markdown-drift + structural orphans are still reported for human review. Default false (scan only)." } } }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
      { name: "batch_get_summary", description: "Fetch {path, title, summary} for many docs in one call. Best-effort per path (missing paths return {path, error}). Max 50 paths. ~90% cheaper than N sequential get_summary calls for enumerate-then-drill workflows.", inputSchema: { type: "object", additionalProperties: false, properties: { paths: { type: "array", items: { type: "string" }, description: "Array of doc paths (max 50)." } }, required: ["paths"] }, annotations: { readOnlyHint: true, openWorldHint: false } },
      { name: "batch_get_doc", description: "Fetch envelope (title + summary + preamble + section headings) for many docs in one call. Envelope-only — for full-body reads use individual get_doc(full=true). Best-effort per path. Max 50.", inputSchema: { type: "object", additionalProperties: false, properties: { paths: { type: "array", items: { type: "string" }, description: "Array of doc paths (max 50)." } }, required: ["paths"] }, annotations: { readOnlyHint: true, openWorldHint: false } },
      { name: "find_similar", description: "Find docs semantically similar to a source doc via Postgres full-text search. Zero external deps (no LLM, no embeddings). Ranks other docs by shared vocabulary with source's title + summary + head. Cloud-only.", inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string", description: "Source doc path." }, limit: { type: "number", description: "Max results. Default 10, max 50." } }, required: ["path"] }, annotations: { readOnlyHint: true, openWorldHint: false } },
      { name: "lint_vault_autofix", description: "Auto-fix vault hygiene: strip redundant assoc bullets, demote extra child_of, add missing back-edges, resolve asymmetric parent claims. Mechanical + idempotent + no data loss. Defaults to dry-run; pass `dry_run:false` to apply.", inputSchema: { type: "object", additionalProperties: false, properties: { dry_run: { type: "boolean", description: "Default true. Pass false to actually write the fixes." } } }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
      { name: "distill_doc", description: "READ-ONLY intake for splitting a notes doc into standalone knowledge nodes. Returns the source + section boundaries + vault context (existing titles for collision check, BRAIN/PATTERN/LEARNINGS rubrics quoted from live canonical docs) + a plan template. Use this to construct a split plan, then call `split_doc` to execute. Does NOT write anything itself. The plan template's instructions REQUIRE verbatim copy of source content — never reword.", inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string" } }, required: ["path"] }, annotations: { readOnlyHint: true, openWorldHint: false } },
      { name: "patch_section", description: "Replace an H2 section's body (version-guarded via `expected_content_hash`). Provide `heading` or `section_id` (preferred; from get_doc.sections[].id). `gate_on_warnings` hard-blocks on lint codes.", inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string" }, heading: { type: "string" }, section_id: { type: "string", description: "Preferred lookup key from get_doc.sections[].id." }, body: { type: "string" }, expected_content_hash: { type: "string" }, gate_on_warnings: { type: "array", items: { type: "string" }, description: "Lint codes to hard-block on. Default []." } }, required: ["path", "body", "expected_content_hash"] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
      { name: "write_doc_preview", description: "Preview the diff that write_doc would produce.", inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] }, annotations: { readOnlyHint: true, openWorldHint: false } },
      { name: "write_doc", description: "Create or overwrite a markdown doc. DESTRUCTIVE — always run write_doc_preview first. Pass `gate_on_warnings: [\"code\", ...]` to hard-block the write when any of those lint codes would fire on the proposed content.", inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string" }, content: { type: "string" }, gate_on_warnings: { type: "array", items: { type: "string" }, description: "Lint codes to hard-block on. Default []." } }, required: ["path", "content"] }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
      { name: "delete_doc", description: "Permanently delete a doc. DESTRUCTIVE — no undo. Returns inbound_edges (docs whose wiki-links will dangle) and title_conflicts (duplicate-title siblings). Call get_neighbors first if unsure.", inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string" } }, required: ["path"] }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
      { name: "split_doc", description: "Atomically refactor a doc into concept nodes. Use when a doc has grown into multiple distinct reusable ideas — extract each into its own node with proper Child of / Parent of sections, then rewrite the source to wiki-link to them. Pre-flight checks block path and H1-title collisions before any writes. Build the extraction plan first (call get_doc to read, then design the new nodes), then call split_doc once to execute.", inputSchema: { type: "object", additionalProperties: false, properties: { source_path: { type: "string" }, rewrite_source_content: { type: "string" }, extracts: { type: "array", items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } }, required: ["source_path", "rewrite_source_content", "extracts"] }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
      { name: "rename_doc", description: "Rename a doc: rewrite its H1, move it to a new path (default: same directory, filename derived from the new title), and update every `[[old_title]]` wiki-link across the vault to point at the new title. Pre-flight checks block title and path collisions. DESTRUCTIVE — rewrites many docs in one call.", inputSchema: { type: "object", additionalProperties: false, properties: { old_path: { type: "string" }, new_title: { type: "string" }, new_path: { type: "string" } }, required: ["old_path", "new_title"] }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
      { name: "rename_title", description: "Bulk-safe wiki-link rewrite. Finds every `[[old_title]]` and `[[old_title|alias]]` across the vault and rewrites to `[[new_title]]` (aliases preserved). Does NOT touch the doc that owns the title — use rename_doc for that. Use rename_title when references have drifted from a doc's actual title (e.g., after a manual rename, or during a large-scale reorganization). Returns count of docs rewritten. Composes with SPRINT-116 syncDocEdges self-heal so per-doc writes stay clean at bulk scale.", inputSchema: { type: "object", additionalProperties: false, properties: { old_title: { type: "string" }, new_title: { type: "string" } }, required: ["old_title", "new_title"] }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
      { name: "patch_preamble", description: "Replace the body region between the H1 and the first H2 (the blockquote summary + any intro paragraphs). The H1 itself is untouched — use rename_doc to change the title. Version-guarded with expected_content_hash from a recent get_doc.preamble. Use this when load-bearing wiki-links sit in the summary or intro and patch_section can't reach them. Pass `gate_on_warnings: [\"code\", ...]` to hard-block the write when any of those lint codes would fire on the proposed content.", inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string" }, body: { type: "string" }, expected_content_hash: { type: "string" }, gate_on_warnings: { type: "array", items: { type: "string" }, description: "Lint codes to hard-block on. Default []." } }, required: ["path", "body", "expected_content_hash"] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
      { name: "materialize_subgroup", description: "Promote an H3 subgroup inside `## Parent of` to a real intermediate parent doc. Atomically creates the intermediate, replaces H3 with a single bullet pointing at it, rewires each affected child's `## Child of`. Use on lint's `subgroup_materialization_candidate`.", inputSchema: { type: "object", additionalProperties: false, properties: { source_path: { type: "string" }, subgroup_heading: { type: "string" }, new_doc_title: { type: "string" }, new_doc_path: { type: "string" }, summary: { type: "string" } }, required: ["source_path", "subgroup_heading"] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
      { name: "create_child", description: "Atomic create-and-link: writes new doc with canonical scaffold AND adds bullet to parent's `## Parent of`. Use instead of write_doc+patch_section for adding child nodes. Refuses on path/title collision. `gate_on_warnings` hard-blocks on lint codes.", inputSchema: { type: "object", additionalProperties: false, properties: { parent_path: { type: "string" }, title: { type: "string" }, body: { type: "string", description: "Optional body content appended after the scaffold's ## Notes header." }, summary: { type: "string", description: "Optional blockquote summary. Falls back to a placeholder." }, child_path: { type: "string", description: "Optional override for the new doc's path. Default: <parent_dir>/<sanitized_title>.md." }, gate_on_warnings: { type: "array", items: { type: "string" }, description: "Lint codes to hard-block on. Default []." } }, required: ["parent_path", "title"] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
      { name: "add_association", description: "Atomic two-sided assoc: patches both docs' `## Associated with` (optional shared label). Refuses if pair is hierarchically linked or siblings. Idempotent. Use instead of two patch_section calls.", inputSchema: { type: "object", additionalProperties: false, properties: { a_path: { type: "string" }, b_path: { type: "string" }, label: { type: "string", description: "Optional shared label appended as ` — <label>` to both bullets." }, gate_on_warnings: { type: "array", items: { type: "string" }, description: "Lint codes to hard-block on (in addition to associate_duplicates_hierarchy and sibling_assoc_redundant which are always hard-gated). Default []." } }, required: ["a_path", "b_path"] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
      { name: "get_image", description: "Fetch an image from the vault and return it as a visual content block so you can see and analyze it. Use this to label images (patch_preamble with a real description) and associate them with relevant docs (add_association). Workflow: list_docs → find images/*.md with '_description pending_' → get_image → patch_preamble → add_association. Returns { doc_path, image_url } plus the image bytes so you can see it.", inputSchema: { type: "object", properties: { doc_path: { type: "string", description: "Path to the image doc, e.g. images/photo-2026-06-09.md." } }, required: ["doc_path"] }, annotations: { readOnlyHint: true, openWorldHint: false } },
      { name: "move_doc", description: "Atomic reparent: rewrites child's `## Child of` + both parents' `## Parent of` in one call. If child has multiple parents, `old_parent_path` must disambiguate. Optional `position` (0-idx) for sibling order. Idempotent.", inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string", description: "Child doc path to reparent." }, new_parent_path: { type: "string", description: "Path of the new parent doc." }, old_parent_path: { type: "string", description: "Disambiguating old parent when the child has multiple Child of bullets. Required only in that case." }, position: { type: "number", description: "Optional 0-indexed bullet position in the new parent's Parent of. Default: append at end." }, gate_on_warnings: { type: "array", items: { type: "string" }, description: "Lint codes to hard-block on. Default []." } }, required: ["path", "new_parent_path"] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
      { name: "trash_doc", description: "Flag a doc as trashed without reparenting or rewriting its markdown. The doc's `## Child of` and `## Parent of` stay intact so restore is lossless. State persists in `.emdee/trashed.json` keyed by doc path. The renderer filters trashed docs from non-graveyard views (filter happens server-side in /api/index). Original parent is derived from the doc's first Child of bullet; pass `original_parent_path` to override. Idempotent: re-trashing returns ok with the existing entry. Use `restore_doc` to reverse.", inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string", description: "Path of the doc to trash." }, original_parent_path: { type: "string", description: "Override the auto-derived restore target. Use when the Child of bullet is ambiguous or unresolvable." } }, required: ["path"] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
      { name: "restore_doc", description: "Reverse a previous `trash_doc`. Clears the doc's entry in `.emdee/trashed.json` so the renderer surfaces it again under its original parent (the Child of edges were never touched). Returns the recorded `original_parent_path` for traceability.", inputSchema: { type: "object", additionalProperties: false, properties: { path: { type: "string", description: "Path of the trashed doc to restore." } }, required: ["path"] }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const { name, arguments: args } = req.params;
    const a = args ?? {};
    // SPRINT-021: fire-and-forget activity log. Only cloud mode has a
    // clerk_id; local dev sessions are skipped. We don't await — the
    // insert latency must never block the tool call.
    if (ctx.mode === "cloud") {
      void logMcpActivity(ctx.userId, ctx.userId, name, a);
    }
    switch (name) {
      case "list_docs":         return await listDocs(ctx, a) as CallToolResult;
      case "list_summary_drift": return await listSummaryDrift(ctx, a) as CallToolResult;
      case "get_summary":       return await getSummary(ctx, a) as CallToolResult;
      case "get_neighbors":     return await getNeighbors(ctx, a) as CallToolResult;
      case "get_context":       return await getContext(ctx, a) as CallToolResult;
      case "get_doc":           return await getDoc(ctx, a) as CallToolResult;
      case "read_doc_section":  return await readDocSection(ctx, a) as CallToolResult;
      case "search":            return await search(ctx, a) as CallToolResult;
      case "append_section":    return await appendSection(ctx, a) as CallToolResult;
      case "patch_section":     return await patchSection(ctx, a) as CallToolResult;
      case "write_doc_preview": return await writeDocPreview(ctx, a) as CallToolResult;
      case "write_doc":         return await writeDoc(ctx, a) as CallToolResult;
      case "delete_doc":        return await deleteDoc(ctx, a) as CallToolResult;
      case "split_doc":         return await splitDoc(ctx, a) as CallToolResult;
      case "rename_doc":        return await renameDoc(ctx, a) as CallToolResult;
      case "rename_title":      return await renameTitle(ctx, a) as CallToolResult;
      case "patch_preamble":    return await patchPreamble(ctx, a) as CallToolResult;
      case "append_doc":        return await appendDoc(ctx, a) as CallToolResult;
      case "lint_doc":          return await lintDoc(ctx, a) as CallToolResult;
      case "lint_vault":        return await lintVault(ctx, a) as CallToolResult;
      case "lint_vault_autofix": return await lintVaultAutofix(ctx, a) as CallToolResult;
      case "reconcile":         return await reconcile(ctx, a) as CallToolResult;
      case "lint_orphans":      return await lintOrphans(ctx, a) as CallToolResult;
      case "batch_get_summary": return await batchGetSummary(ctx, a) as CallToolResult;
      case "batch_get_doc":     return await batchGetDoc(ctx, a) as CallToolResult;
      case "find_similar":      return await findSimilar(ctx, a) as CallToolResult;
      case "distill_doc":       return await distillDoc(ctx, a) as CallToolResult;
      case "materialize_subgroup": return await materializeSubgroup(ctx, a) as CallToolResult;
      case "create_child":      return await createChild(ctx, a) as CallToolResult;
      case "add_association":   return await addAssociation(ctx, a) as CallToolResult;
      case "get_image":         return await getImage(ctx, a) as CallToolResult;
      case "move_doc":          return await moveDoc(ctx, a) as CallToolResult;
      case "trash_doc":         return await trashDoc(ctx, a) as CallToolResult;
      case "restore_doc":       return await restoreDoc(ctx, a) as CallToolResult;
      default: throw new Error(`unknown tool: ${name}`);
    }
  });

  return server;
}

async function handleMcp(request: Request): Promise<Response> {
  const origin = new URL(request.url).origin;

  // Local dev: skip OAuth, use EMDEE_DOCS
  const docsDir = process.env.EMDEE_DOCS;
  if (docsDir) {
    const path = await import("node:path");
    const ctx: ToolContext = { mode: "local", docsDir: path.resolve(docsDir) };
    const server = buildMcpServer(ctx);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    return withCors(await transport.handleRequest(request));
  }

  // Cloud: require OAuth bearer token
  const clerkId = await clerkIdFromOAuthToken(request);
  if (!clerkId) return bearerChallenge(origin);

  const storage = new SupabaseStorage();
  const { cloudDatabase } = await import("@/src/lib/database");
  const ctx: ToolContext = { mode: "cloud", storage, userId: clerkId, db: cloudDatabase() };
  const server = buildMcpServer(ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return withCors(await transport.handleRequest(request));
}

export const GET = handleMcp;
export const POST = handleMcp;
export const DELETE = handleMcp;
export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
