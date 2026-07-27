// SPRINT-091 chunk 2: write-side CLI verbs.
//
// Dispatcher that fronts the 8 most-common write tools as CLI commands.
// Every verb accepts --remote (routes through cloud) and --json (returns
// the raw MCP envelope for machine consumption). Local mode calls the tool
// function directly with the same ToolContext shape MCP uses — same code,
// same guards, same errors.
//
// One dispatcher rather than one file per verb keeps the wire-up compact.
// bin/emdee.js just shells `write-commands.ts <verb> <args>` for each.

import path from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import type { ToolContext } from "../lib/mcp/tools/types";
import { localToolContext } from "../lib/mcp/tools/context";
import { patchSection } from "../lib/mcp/tools/patch_section";
import { appendSection } from "../lib/mcp/tools/append_section";
import { appendDoc } from "../lib/mcp/tools/append_doc";
import { patchPreamble } from "../lib/mcp/tools/patch_preamble";
import { createChild } from "../lib/mcp/tools/create_child";
import { addAssociation } from "../lib/mcp/tools/add_association";
import { moveDoc } from "../lib/mcp/tools/move_doc";
import { renameDoc } from "../lib/mcp/tools/rename_doc";
import { renameTitle } from "../lib/mcp/tools/rename_title";
import { writeDoc } from "../lib/mcp/tools/write_doc";
import { writeDocPreview } from "../lib/mcp/tools/write_doc_preview";
import { trashDoc } from "../lib/mcp/tools/trash_doc";
import { restoreDoc } from "../lib/mcp/tools/restore_doc";
import { deleteDoc } from "../lib/mcp/tools/delete_doc";
import { distillDoc } from "../lib/mcp/tools/distill_doc";
import { materializeSubgroup } from "../lib/mcp/tools/materialize_subgroup";
import { splitDoc } from "../lib/mcp/tools/split_doc";
import { reconcile } from "../lib/mcp/tools/reconcile";
import { lintOrphans } from "../lib/mcp/tools/lint_orphans";
import { batchGetSummary, batchGetDoc } from "../lib/mcp/tools/batch_get";
import { findSimilar } from "../lib/mcp/tools/find_similar";
import { getDoc } from "../lib/mcp/tools/get_doc";
import { uploadImage } from "../lib/mcp/tools/upload_image";
import { readFileSync } from "node:fs";
import { callTool, unwrapText } from "./remote-client";
import { NeedsLoginError } from "./auth";
import { readCache, writeCacheEntry, purgeCache, isCacheable } from "./cache";

const docsDir = path.resolve(process.env.EMDEE_DOCS ?? path.join(process.cwd(), "docs"));

type ToolFn = (ctx: ToolContext, args: Record<string, unknown>) => Promise<unknown>;

interface VerbSpec {
  toolName: string;
  toolFn: ToolFn;
  parse: ParseArgsConfig["options"];
  buildArgs: (values: Record<string, string | boolean | undefined>) => Record<string, unknown>;
}

// Shared flags. Every write verb accepts these.
const COMMON = {
  remote: { type: "boolean" },
  json: { type: "boolean" },
  "no-cache": { type: "boolean" },
  "no-auto-hash": { type: "boolean" },
} as const;

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function optionalString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

const VERBS: Record<string, VerbSpec> = {
  "patch-section": {
    toolName: "patch_section",
    toolFn: patchSection as unknown as ToolFn,
    parse: {
      ...COMMON,
      path: { type: "string" },
      "section-id": { type: "string" },
      heading: { type: "string" },
      body: { type: "string" },
      "expected-hash": { type: "string" },
      "gate-on": { type: "string", multiple: true },
    },
    buildArgs: (v) => {
      const args: Record<string, unknown> = {
        path: asString(v.path),
        body: asString(v.body),
        expected_content_hash: asString(v["expected-hash"]),
      };
      if (v["section-id"]) args.section_id = v["section-id"];
      if (v.heading) args.heading = v.heading;
      if (Array.isArray(v["gate-on"])) args.gate_on_warnings = v["gate-on"];
      return args;
    },
  },
  "append-section": {
    toolName: "append_section",
    toolFn: appendSection as unknown as ToolFn,
    parse: {
      ...COMMON,
      path: { type: "string" },
      "section-id": { type: "string" },
      heading: { type: "string" },
      body: { type: "string" },
      "create-if-missing": { type: "boolean" },
      "gate-on": { type: "string", multiple: true },
      "expected-hash": { type: "string" },
    },
    buildArgs: (v) => {
      const args: Record<string, unknown> = {
        path: asString(v.path),
        body: asString(v.body),
      };
      if (v["section-id"]) args.section_id = v["section-id"];
      if (v.heading) args.heading = v.heading;
      if (v["create-if-missing"]) args.create_if_missing = true;
      if (Array.isArray(v["gate-on"])) args.gate_on_warnings = v["gate-on"];
      if (v["expected-hash"]) args.expected_content_hash = asString(v["expected-hash"]);
      return args;
    },
  },
  "append-doc": {
    toolName: "append_doc",
    toolFn: appendDoc as unknown as ToolFn,
    parse: {
      ...COMMON,
      path: { type: "string" },
      body: { type: "string" },
      "gate-on": { type: "string", multiple: true },
      "expected-hash": { type: "string" },
    },
    buildArgs: (v) => {
      const args: Record<string, unknown> = { path: asString(v.path), body: asString(v.body) };
      if (Array.isArray(v["gate-on"])) args.gate_on_warnings = v["gate-on"];
      if (v["expected-hash"]) args.expected_content_hash = asString(v["expected-hash"]);
      return args;
    },
  },
  "patch-preamble": {
    toolName: "patch_preamble",
    toolFn: patchPreamble as unknown as ToolFn,
    parse: {
      ...COMMON,
      path: { type: "string" },
      body: { type: "string" },
      "expected-hash": { type: "string" },
      "gate-on": { type: "string", multiple: true },
    },
    buildArgs: (v) => {
      const args: Record<string, unknown> = {
        path: asString(v.path),
        body: asString(v.body),
        expected_content_hash: asString(v["expected-hash"]),
      };
      if (Array.isArray(v["gate-on"])) args.gate_on_warnings = v["gate-on"];
      return args;
    },
  },
  "create-child": {
    toolName: "create_child",
    toolFn: createChild as unknown as ToolFn,
    parse: {
      ...COMMON,
      "parent-path": { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
      summary: { type: "string" },
      "child-path": { type: "string" },
      "gate-on": { type: "string", multiple: true },
      "expected-parent-hash": { type: "string" },
    },
    buildArgs: (v) => {
      const args: Record<string, unknown> = {
        parent_path: asString(v["parent-path"]),
        title: asString(v.title),
      };
      const body = optionalString(v.body);
      if (body) args.body = body;
      const summary = optionalString(v.summary);
      if (summary) args.summary = summary;
      const childPath = optionalString(v["child-path"]);
      if (childPath) args.child_path = childPath;
      if (Array.isArray(v["gate-on"])) args.gate_on_warnings = v["gate-on"];
      if (v["expected-parent-hash"]) args.expected_parent_content_hash = asString(v["expected-parent-hash"]);
      return args;
    },
  },
  "add-association": {
    toolName: "add_association",
    toolFn: addAssociation as unknown as ToolFn,
    parse: {
      ...COMMON,
      "a-path": { type: "string" },
      "b-path": { type: "string" },
      label: { type: "string" },
      "gate-on": { type: "string", multiple: true },
      "expected-a-hash": { type: "string" },
      "expected-b-hash": { type: "string" },
    },
    buildArgs: (v) => {
      const args: Record<string, unknown> = {
        a_path: asString(v["a-path"]),
        b_path: asString(v["b-path"]),
      };
      const label = optionalString(v.label);
      if (label) args.label = label;
      if (Array.isArray(v["gate-on"])) args.gate_on_warnings = v["gate-on"];
      if (v["expected-a-hash"]) args.expected_a_content_hash = asString(v["expected-a-hash"]);
      if (v["expected-b-hash"]) args.expected_b_content_hash = asString(v["expected-b-hash"]);
      return args;
    },
  },
  "move-doc": {
    toolName: "move_doc",
    toolFn: moveDoc as unknown as ToolFn,
    parse: {
      ...COMMON,
      path: { type: "string" },
      "new-parent-path": { type: "string" },
      "old-parent-path": { type: "string" },
      position: { type: "string" },
      "gate-on": { type: "string", multiple: true },
      "expected-child-hash": { type: "string" },
      "expected-old-parent-hash": { type: "string" },
      "expected-new-parent-hash": { type: "string" },
    },
    buildArgs: (v) => {
      const args: Record<string, unknown> = {
        path: asString(v.path),
        new_parent_path: asString(v["new-parent-path"]),
      };
      const oldParent = optionalString(v["old-parent-path"]);
      if (oldParent) args.old_parent_path = oldParent;
      const pos = optionalString(v.position);
      if (pos) args.position = Number(pos);
      if (Array.isArray(v["gate-on"])) args.gate_on_warnings = v["gate-on"];
      if (v["expected-child-hash"]) args.expected_child_content_hash = asString(v["expected-child-hash"]);
      if (v["expected-old-parent-hash"]) args.expected_old_parent_content_hash = asString(v["expected-old-parent-hash"]);
      if (v["expected-new-parent-hash"]) args.expected_new_parent_content_hash = asString(v["expected-new-parent-hash"]);
      return args;
    },
  },
  "rename-doc": {
    toolName: "rename_doc",
    toolFn: renameDoc as unknown as ToolFn,
    parse: {
      ...COMMON,
      "old-path": { type: "string" },
      "new-title": { type: "string" },
      "new-path": { type: "string" },
      "expected-hash": { type: "string" },
    },
    buildArgs: (v) => {
      const args: Record<string, unknown> = {
        old_path: asString(v["old-path"]),
        new_title: asString(v["new-title"]),
      };
      const newPath = optionalString(v["new-path"]);
      if (newPath) args.new_path = newPath;
      if (v["expected-hash"]) args.expected_content_hash = asString(v["expected-hash"]);
      return args;
    },
  },
  "rename-title": {
    toolName: "rename_title",
    toolFn: renameTitle as unknown as ToolFn,
    parse: {
      ...COMMON,
      "old-title": { type: "string" },
      "new-title": { type: "string" },
    },
    buildArgs: (v) => ({
      old_title: asString(v["old-title"]),
      new_title: asString(v["new-title"]),
    }),
  },
  "write-doc": {
    toolName: "write_doc",
    toolFn: writeDoc as unknown as ToolFn,
    parse: {
      ...COMMON,
      path: { type: "string" },
      content: { type: "string" },
      "gate-on": { type: "string", multiple: true },
      "expected-hash": { type: "string" },
    },
    buildArgs: (v) => {
      const args: Record<string, unknown> = {
        path: asString(v.path),
        content: asString(v.content),
      };
      if (Array.isArray(v["gate-on"])) args.gate_on_warnings = v["gate-on"];
      if (v["expected-hash"]) args.expected_content_hash = asString(v["expected-hash"]);
      return args;
    },
  },
  "write-doc-preview": {
    toolName: "write_doc_preview",
    toolFn: writeDocPreview as unknown as ToolFn,
    parse: {
      ...COMMON,
      path: { type: "string" },
      content: { type: "string" },
    },
    buildArgs: (v) => ({
      path: asString(v.path),
      content: asString(v.content),
    }),
  },
  "trash-doc": {
    toolName: "trash_doc",
    toolFn: trashDoc as unknown as ToolFn,
    parse: {
      ...COMMON,
      path: { type: "string" },
      "original-parent-path": { type: "string" },
      "expected-hash": { type: "string" },
    },
    buildArgs: (v) => {
      const args: Record<string, unknown> = { path: asString(v.path) };
      const op = optionalString(v["original-parent-path"]);
      if (op) args.original_parent_path = op;
      if (v["expected-hash"]) args.expected_content_hash = asString(v["expected-hash"]);
      return args;
    },
  },
  "restore-doc": {
    toolName: "restore_doc",
    toolFn: restoreDoc as unknown as ToolFn,
    parse: { ...COMMON, path: { type: "string" } },
    buildArgs: (v) => ({ path: asString(v.path) }),
  },
  "delete-doc": {
    toolName: "delete_doc",
    toolFn: deleteDoc as unknown as ToolFn,
    parse: { ...COMMON, path: { type: "string" }, "expected-hash": { type: "string" } },
    buildArgs: (v) => {
      const args: Record<string, unknown> = { path: asString(v.path) };
      if (v["expected-hash"]) args.expected_content_hash = asString(v["expected-hash"]);
      return args;
    },
  },
  "distill-doc": {
    // READ-ONLY intake for split planning — lives under write commands
    // alongside its executor split_doc so users find them together.
    toolName: "distill_doc",
    toolFn: distillDoc as unknown as ToolFn,
    parse: { ...COMMON, path: { type: "string" } },
    buildArgs: (v) => ({ path: asString(v.path) }),
  },
  "materialize-subgroup": {
    toolName: "materialize_subgroup",
    toolFn: materializeSubgroup as unknown as ToolFn,
    parse: {
      ...COMMON,
      "source-path": { type: "string" },
      "subgroup-heading": { type: "string" },
      "new-doc-title": { type: "string" },
      "new-doc-path": { type: "string" },
      summary: { type: "string" },
      "expected-source-hash": { type: "string" },
    },
    buildArgs: (v) => {
      const args: Record<string, unknown> = {
        source_path: asString(v["source-path"]),
        subgroup_heading: asString(v["subgroup-heading"]),
      };
      const t = optionalString(v["new-doc-title"]);
      if (t) args.new_doc_title = t;
      const p = optionalString(v["new-doc-path"]);
      if (p) args.new_doc_path = p;
      const s = optionalString(v.summary);
      if (s) args.summary = s;
      if (v["expected-source-hash"]) args.expected_source_content_hash = asString(v["expected-source-hash"]);
      return args;
    },
  },
  "split-doc": {
    toolName: "split_doc",
    toolFn: splitDoc as unknown as ToolFn,
    parse: {
      ...COMMON,
      "source-path": { type: "string" },
      "rewrite-source-content": { type: "string" },
      // Extracts is a complex array-of-objects; take it via --extracts-file
      // pointing at a JSON document rather than shoehorn it into a flag.
      "extracts-file": { type: "string" },
      "expected-hash": { type: "string" },
    },
    buildArgs: (v) => {
      const args: Record<string, unknown> = {
        source_path: asString(v["source-path"]),
        rewrite_source_content: asString(v["rewrite-source-content"]),
      };
      const extractsFile = optionalString(v["extracts-file"]);
      if (extractsFile) {
        const parsed = JSON.parse(readFileSync(extractsFile, "utf8"));
        args.extracts = parsed;
      }
      if (v["expected-hash"]) args.expected_content_hash = asString(v["expected-hash"]);
      return args;
    },
  },
  reconcile: {
    toolName: "reconcile",
    toolFn: reconcile as unknown as ToolFn,
    parse: {
      ...COMMON,
      path: { type: "string" },
      all: { type: "boolean" },
    },
    buildArgs: (v) => {
      const args: Record<string, unknown> = {};
      const p = optionalString(v.path);
      if (p) args.path = p;
      if (v.all) args.all = true;
      return args;
    },
  },
  "lint-orphans": {
    toolName: "lint_orphans",
    toolFn: lintOrphans as unknown as ToolFn,
    parse: {
      ...COMMON,
      fix: { type: "boolean" },
    },
    buildArgs: (v) => {
      const args: Record<string, unknown> = {};
      if (v.fix) args.fix = true;
      return args;
    },
  },
  "batch-get-summary": {
    toolName: "batch_get_summary",
    toolFn: batchGetSummary as unknown as ToolFn,
    parse: {
      ...COMMON,
      path: { type: "string", multiple: true },
    },
    buildArgs: (v) => {
      const paths = Array.isArray(v.path) ? v.path : (v.path ? [v.path] : []);
      return { paths };
    },
  },
  "batch-get-doc": {
    toolName: "batch_get_doc",
    toolFn: batchGetDoc as unknown as ToolFn,
    parse: {
      ...COMMON,
      path: { type: "string", multiple: true },
    },
    buildArgs: (v) => {
      const paths = Array.isArray(v.path) ? v.path : (v.path ? [v.path] : []);
      return { paths };
    },
  },
  "find-similar": {
    toolName: "find_similar",
    toolFn: findSimilar as unknown as ToolFn,
    parse: {
      ...COMMON,
      path: { type: "string" },
      limit: { type: "string" },
    },
    buildArgs: (v) => {
      const args: Record<string, unknown> = { path: asString(v.path) };
      const lim = optionalString(v.limit);
      if (lim) args.limit = Number(lim);
      return args;
    },
  },
  // SPRINT-168: upload an image file to the vault's Supabase Storage
  // bucket + create an accompanying markdown doc that references it.
  // Reads the file, base64-encodes, infers media type from extension
  // (or accepts explicit --media-type override), and shells to the
  // uploadImage tool. Cloud-only; the tool refuses local mode.
  "upload-image": {
    toolName: "upload_image",
    toolFn: uploadImage as unknown as ToolFn,
    parse: {
      ...COMMON,
      file: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      path: { type: "string" },
      "media-type": { type: "string" },
      "no-rasterize": { type: "boolean" },
    },
    buildArgs: (v) => {
      const filePath = asString(v.file);
      if (!filePath) throw new Error("upload-image requires --file <path-to-image>");
      const buf = readFileSync(filePath);
      const inferMediaType = (p: string): string => {
        const ext = p.toLowerCase().split(".").pop() ?? "";
        const map: Record<string, string> = {
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          png: "image/png",
          gif: "image/gif",
          webp: "image/webp",
          svg: "image/svg+xml",
        };
        return map[ext] ?? "";
      };
      const mediaType = optionalString(v["media-type"]) ?? inferMediaType(filePath);
      if (!mediaType) throw new Error(`upload-image can't infer media_type from ${filePath} — pass --media-type explicitly`);
      const args: Record<string, unknown> = {
        image_data: buf.toString("base64"),
        media_type: mediaType,
      };
      const title = optionalString(v.title);
      if (title) args.title = title;
      const desc = optionalString(v.description);
      if (desc) args.description = desc;
      const p = optionalString(v.path);
      if (p) args.path = p;
      // SPRINT-169: SVG auto-rasterises by default. --no-rasterize
      // keeps only the SVG (for cases where you don't want a PNG
      // sibling — e.g. static blog embeds where SVG renders fine).
      if (v["no-rasterize"] === true) args.rasterize = false;
      return args;
    },
  },
};

function formatOutput(result: unknown, wantJson: boolean): string {
  // MCP tools return { content: [{type: "text", text: "..."}] }. The text
  // is JSON. For human-friendly output we pull the parsed JSON out and
  // pretty-print. For --json we return the parsed JSON as-is.
  let payload: unknown = result;
  const withContent = result as { content?: Array<{ type: string; text?: string }> };
  if (withContent.content?.[0]?.type === "text" && typeof withContent.content[0].text === "string") {
    try {
      payload = JSON.parse(withContent.content[0].text);
    } catch {
      payload = withContent.content[0].text;
    }
  }
  if (wantJson) return JSON.stringify(payload, null, 2);
  if (typeof payload === "string") return payload;
  return JSON.stringify(payload, null, 2);
}

// SPRINT-127: parse a tool response and detect the common error shape
// (`{ error: "code", ...extra }` in payload). Returns null when there's
// no error to surface. Human-message lookup lives in ERROR_HINTS.
interface ToolErrorInfo { code: string; message: string; }

const ERROR_HINTS: Record<string, (e: Record<string, unknown>) => string> = {
  version_conflict: () => "Section content changed since you last read it. Re-fetch with `emdee read-doc-section` and retry with the fresh hash.",
  hash_mismatch: () => "Section content changed since you last read it. Re-fetch with `emdee read-doc-section` and retry with the fresh hash.",
  section_id_heading_mismatch: () => "The section_id and heading you passed resolve to different sections. Use one or the other.",
  cloud_mode_required: () => "This tool needs cloud mode. Pass --remote (or set default_mode:remote in ~/.emdee/config.json).",
  path_required: () => "Missing required --path argument.",
  paths_required: () => "Missing required --path arguments. Pass --path repeatedly or --stdin for a piped list.",
  ambiguous_parent: () => "The doc has multiple parents. Pass --old-parent-path to disambiguate.",
  unresolved_parent: (e) => `The doc's Child of bullet points to \`[[${e.declared_parent_title ?? "?"}]]\` which doesn't exist. Fix the wiki-link first, or pass --original-parent-path.`,
  no_resolvable_parent: () => "The doc has no `## Child of` bullet. Give it a parent (or pass --original-parent-path) before trashing.",
  would_duplicate_hierarchy: () => "add_association refused: pair is already hierarchically linked or shares a parent.",
  lint_gate_failed: () => "Lint gate blocked the write. See warnings in the JSON output for what to fix.",
  titles_identical: () => "rename_title refused: old_title equals new_title. No-op.",
  missing_required: () => "Missing required argument. Check the verb's --help for the required flags.",
  doc_not_found: (e) => `No such doc: ${e.path ?? "?"}`,
  source_doc_not_found: (e) => `Source doc not found: ${e.path ?? "?"}`,
};

// SPRINT-160: OCC auto-hydration + retry.
//
// Motivation: create_child and add_association do read-full-doc →
// append-bullet → write-full-doc under the hood. When agents run these
// concurrently against the same parent (as happened during the CV /
// BLOCKCHAIN research migration), the second write reads a stale
// snapshot and clobbers sections the first write added.
//
// The tools ALREADY support expected_content_hash guards (SPRINT-141),
// but the CLI never passed them, so the guards were skipped and races
// slipped through. Fix: fetch the hash right before the write, pass it,
// and retry once on version_conflict. Now concurrent CLI calls are
// serializable — the losing write gets a conflict, refetches, retries
// with the fresh state, and both bullets land.
//
// Opt out with `--no-auto-hash` when you want to accept clobbering (e.g.
// scripted bulk backfills). Default is safe.

interface OccSpec {
  hashArg: string; // key in the args object the tool consumes
  pathArg: string; // key in the args object that holds the doc path to hash
}

// Only doc-scoped verbs auto-hydrate — their expected-hash arg maps to
// the doc's content_hash returned by get_doc.doc_content_hash.
// Section-scoped verbs (patch-section, append-section, patch-preamble)
// need the section's own content_hash from get_doc.sections[].content_hash,
// which is a different feature and stays manual for now.
const OCC_SPECS: Record<string, OccSpec[]> = {
  "append-doc": [{ hashArg: "expected_content_hash", pathArg: "path" }],
  "write-doc": [{ hashArg: "expected_content_hash", pathArg: "path" }],
  "delete-doc": [{ hashArg: "expected_content_hash", pathArg: "path" }],
  "create-child": [{ hashArg: "expected_parent_content_hash", pathArg: "parent_path" }],
  "add-association": [
    { hashArg: "expected_a_content_hash", pathArg: "a_path" },
    { hashArg: "expected_b_content_hash", pathArg: "b_path" },
  ],
  "move-doc": [
    { hashArg: "expected_child_content_hash", pathArg: "path" },
    { hashArg: "expected_old_parent_content_hash", pathArg: "old_parent_path" },
    { hashArg: "expected_new_parent_content_hash", pathArg: "new_parent_path" },
  ],
  "rename-doc": [{ hashArg: "expected_content_hash", pathArg: "old_path" }],
  "trash-doc": [{ hashArg: "expected_content_hash", pathArg: "path" }],
};

const OCC_MAX_RETRIES = 3;

async function fetchDocHash(docPath: string, remote: boolean): Promise<string | null> {
  const argsIn = { path: docPath };
  const raw = remote
    ? await callTool("get_doc", argsIn)
    : await getDoc(localToolContext(docsDir), argsIn);
  const text = unwrapText(raw as { content?: Array<{ type: string; text?: string }> });
  try {
    const parsed = JSON.parse(text) as { doc_content_hash?: string; error?: string };
    if (parsed.error) return null;
    return parsed.doc_content_hash ?? null;
  } catch {
    return null;
  }
}

/**
 * Fill in every OCC hash arg that (a) the verb supports and (b) the
 * caller didn't already set. Missing paths / doc-not-found responses
 * are skipped silently — the underlying tool will surface its own
 * error if the path is truly invalid.
 */
async function hydrateOccHashes(
  verbName: string,
  args: Record<string, unknown>,
  remote: boolean,
): Promise<Record<string, unknown>> {
  const specs = OCC_SPECS[verbName];
  if (!specs || specs.length === 0) return args;
  const next = { ...args };
  for (const { hashArg, pathArg } of specs) {
    if (typeof next[hashArg] === "string" && (next[hashArg] as string).length > 0) continue;
    const docPath = next[pathArg];
    if (typeof docPath !== "string" || docPath.length === 0) continue;
    const hash = await fetchDocHash(docPath, remote);
    if (hash) next[hashArg] = hash;
  }
  return next;
}

function extractError(text: string): ToolErrorInfo | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const code = typeof obj.error === "string" ? obj.error : null;
  if (!code) return null;
  const hint = ERROR_HINTS[code];
  const message = hint
    ? hint(obj)
    : `Tool returned error \`${code}\`. Details: ${JSON.stringify(obj, null, 2)}`;
  return { code, message };
}

async function runVerb(verbName: string, argv: string[]): Promise<void> {
  const spec = VERBS[verbName];
  if (!spec) {
    process.stderr.write(`unknown write verb: ${verbName}\navailable: ${Object.keys(VERBS).join(", ")}\n`);
    process.exit(1);
  }
  const { values: rawValues } = parseArgs({ args: argv, options: spec.parse, strict: true });
  const values = rawValues as unknown as Record<string, string | boolean | undefined>;
  const args = spec.buildArgs(values);
  const wantJson = Boolean(values.json);
  const remote = Boolean(values.remote);

  // SPRINT-128: response cache for read-only tools. On hit, skip the
  // network/local call entirely. `--no-cache` bypasses. Write tools
  // purge the whole cache on success (see below) so we never serve
  // stale reads after mutations.
  const noCache = Boolean(values["no-cache"]);
  const scope = remote ? "cloud" : docsDir;
  let result: unknown;
  let cacheHit = false;
  if (!noCache && isCacheable(spec.toolName)) {
    const cached = await readCache(spec.toolName, args, remote, scope);
    if (cached !== null) {
      result = cached;
      cacheHit = true;
    }
  }
  // SPRINT-160: hydrate OCC hashes right before the call, so concurrent
  // writes to the same doc get version_conflict instead of clobbering.
  const autoHash = !Boolean(values["no-auto-hash"]);
  let effectiveArgs = args;
  let responseText = "";
  let errInfo: ToolErrorInfo | null = null;

  if (!cacheHit) {
    let attempt = 0;
    // Retry loop for version_conflict — refetches hashes and retries with
    // fresh state. Only kicks in when auto-hash is on and the verb has an
    // OCC spec. Caps at OCC_MAX_RETRIES to avoid unbounded looping if
    // there's a real contention storm.
    while (true) {
      effectiveArgs = autoHash ? await hydrateOccHashes(verbName, args, remote) : args;
      result = remote
        ? await callTool(spec.toolName, effectiveArgs).then((r) => r as unknown)
        : await spec.toolFn(localToolContext(docsDir), effectiveArgs);
      responseText = remote
        ? unwrapText(result as { content?: Array<{ type: string; text?: string }> })
        : ((result as { content?: Array<{ type: string; text?: string }> }).content?.[0]?.text ?? "");
      errInfo = extractError(responseText);
      const isConflict = errInfo && (errInfo.code === "version_conflict" || errInfo.code === "hash_mismatch");
      if (!isConflict || !autoHash || !OCC_SPECS[verbName] || attempt >= OCC_MAX_RETRIES) break;
      attempt++;
    }
  } else {
    responseText = remote
      ? unwrapText(result as { content?: Array<{ type: string; text?: string }> })
      : ((result as { content?: Array<{ type: string; text?: string }> }).content?.[0]?.text ?? "");
    errInfo = extractError(responseText);
  }

  // Cache successful read responses; purge cache on successful write.
  if (!cacheHit && !errInfo) {
    if (isCacheable(spec.toolName)) {
      await writeCacheEntry(spec.toolName, args, remote, scope, result);
    } else {
      // Non-cacheable = mutation tool → invalidate all cached reads.
      await purgeCache();
    }
  }

  const output = remote
    ? formatOutput({ content: [{ type: "text", text: responseText }] }, wantJson)
    : formatOutput(result, wantJson);

  if (errInfo && !wantJson) {
    process.stderr.write(`error: ${errInfo.code}\n${errInfo.message}\n`);
    process.exit(1);
  }
  process.stdout.write(output + "\n");
  if (errInfo && wantJson) process.exit(1);
}

const [, , verb, ...rest] = process.argv;

async function main(): Promise<void> {
  if (!verb) {
    process.stderr.write(`usage: emdee <verb> [options]\nverbs: ${Object.keys(VERBS).join(", ")}\n`);
    process.exit(1);
  }
  await runVerb(verb, rest);
}

main().catch((err) => {
  if (err instanceof NeedsLoginError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
