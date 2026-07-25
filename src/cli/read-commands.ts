// SPRINT-091 chunks 1+3: CLI read verbs.
//
// Two flavours of reads:
//   - Bytes-only: `list`, `drift-batch` — legacy verbs, print raw text
//   - Structured: `get-doc`, `get-summary`, `get-neighbors`, `get-context`,
//     `search`, `read-doc-section`, `list-summary-drift` — table-driven
//     dispatcher entries. Each takes --remote (routes cloud), --format
//     (text|json, default text where available), and prints unwrapped payload.
//
// Structured reads share the dispatcher with writes' shape so the surface
// stays consistent, but their `formatOutput` collapses the MCP envelope by
// default (users want the actual body, not JSON metadata).

import path from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { buildIndex } from "../core/indexer";
import { callTool, unwrapText } from "./remote-client";
import { NeedsLoginError } from "./auth";
import { readCache, writeCacheEntry, isCacheable } from "./cache";
import type { ToolContext } from "../lib/mcp/tools/types";
import { getDoc } from "../lib/mcp/tools/get_doc";
import { getSummary } from "../lib/mcp/tools/get_summary";
import { getNeighbors } from "../lib/mcp/tools/get_neighbors";
import { getContext } from "../lib/mcp/tools/get_context";
import { search } from "../lib/mcp/tools/search";
import { readDocSection } from "../lib/mcp/tools/read_doc_section";
import { listDocs } from "../lib/mcp/tools/list_docs";
import { listSummaryDrift } from "../lib/mcp/tools/list_summary_drift";
import { lintDoc } from "../lib/mcp/tools/lint_doc";
import { lintVault } from "../lib/mcp/tools/lint_vault";
import { lintVaultAutofix } from "../lib/mcp/tools/lint_vault_autofix";
import { getImage } from "../lib/mcp/tools/get_image";
import { writeFileSync } from "node:fs";

const docsDir = path.resolve(process.env.EMDEE_DOCS ?? path.join(process.cwd(), "docs"));

type ToolFn = (ctx: ToolContext, args: Record<string, unknown>) => Promise<unknown>;

interface ReadVerb {
  toolName: string;
  toolFn: ToolFn;
  parse: ParseArgsConfig["options"];
  buildArgs: (values: Record<string, string | boolean | undefined>) => Record<string, unknown>;
}

const COMMON = {
  remote: { type: "boolean" },
  format: { type: "string" },
  json: { type: "boolean" },
  "no-cache": { type: "boolean" },
} as const;

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function optionalString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

const READ_VERBS: Record<string, ReadVerb> = {
  "get-doc": {
    toolName: "get_doc",
    toolFn: getDoc as unknown as ToolFn,
    parse: {
      ...COMMON,
      path: { type: "string" },
      full: { type: "boolean" },
      "expected-hash": { type: "string" },
    },
    buildArgs: (v) => {
      const args: Record<string, unknown> = { path: asString(v.path) };
      if (v.full) args.full = true;
      if (v.format === "text") args.format = "text";
      const expected = optionalString(v["expected-hash"]);
      if (expected) args.expected_content_hash = expected;
      return args;
    },
  },
  "get-summary": {
    toolName: "get_summary",
    toolFn: getSummary as unknown as ToolFn,
    parse: { ...COMMON, path: { type: "string" } },
    buildArgs: (v) => {
      const args: Record<string, unknown> = { path: asString(v.path) };
      if (v.format === "text") args.format = "text";
      return args;
    },
  },
  "get-neighbors": {
    toolName: "get_neighbors",
    toolFn: getNeighbors as unknown as ToolFn,
    parse: { ...COMMON, path: { type: "string" } },
    buildArgs: (v) => ({ path: asString(v.path) }),
  },
  "get-context": {
    toolName: "get_context",
    toolFn: getContext as unknown as ToolFn,
    parse: {
      ...COMMON,
      path: { type: "string" },
      hops: { type: "string" },
      "budget-tokens": { type: "string" },
      "include-full": { type: "boolean" },
      "include-associates": { type: "boolean" },
      "expected-hash": { type: "string" },
    },
    buildArgs: (v) => {
      const args: Record<string, unknown> = { path: asString(v.path) };
      const hops = optionalString(v.hops);
      if (hops) args.hops = Number(hops);
      const budget = optionalString(v["budget-tokens"]);
      if (budget) args.budget_tokens = Number(budget);
      if (v["include-full"] === true) args.include_full = true;
      if (v["include-associates"] === true) args.include_associates = true;
      const expected = optionalString(v["expected-hash"]);
      if (expected) args.expected_content_hash = expected;
      return args;
    },
  },
  search: {
    toolName: "search",
    toolFn: search as unknown as ToolFn,
    parse: { ...COMMON, query: { type: "string" }, limit: { type: "string" } },
    buildArgs: (v) => {
      const args: Record<string, unknown> = { query: asString(v.query) };
      const limit = optionalString(v.limit);
      if (limit) args.limit = Number(limit);
      return args;
    },
  },
  "read-doc-section": {
    toolName: "read_doc_section",
    toolFn: readDocSection as unknown as ToolFn,
    parse: {
      ...COMMON,
      path: { type: "string" },
      "section-id": { type: "string" },
      heading: { type: "string" },
      "expected-hash": { type: "string" },
    },
    buildArgs: (v) => {
      const args: Record<string, unknown> = { path: asString(v.path) };
      const sid = optionalString(v["section-id"]);
      if (sid) args.section_id = sid;
      const heading = optionalString(v.heading);
      if (heading) args.heading = heading;
      const expected = optionalString(v["expected-hash"]);
      if (expected) args.expected_content_hash = expected;
      return args;
    },
  },
  "list-docs": {
    toolName: "list_docs",
    toolFn: listDocs as unknown as ToolFn,
    parse: { ...COMMON, prefix: { type: "string" } },
    buildArgs: (v) => {
      const args: Record<string, unknown> = {};
      if (v.format === "text") args.format = "text";
      return args;
    },
  },
  "list-summary-drift": {
    toolName: "list_summary_drift",
    toolFn: listSummaryDrift as unknown as ToolFn,
    parse: {
      ...COMMON,
      prefix: { type: "string" },
      limit: { type: "string" },
      offset: { type: "string" },
    },
    buildArgs: (v) => {
      const args: Record<string, unknown> = {};
      const prefix = optionalString(v.prefix);
      if (prefix) args.prefix = prefix;
      const limit = optionalString(v.limit);
      if (limit) args.limit = Number(limit);
      const offset = optionalString(v.offset);
      if (offset) args.offset = Number(offset);
      if (v.format === "text") args.format = "text";
      return args;
    },
  },
  "lint-doc": {
    toolName: "lint_doc",
    toolFn: lintDoc as unknown as ToolFn,
    parse: { ...COMMON, path: { type: "string" } },
    buildArgs: (v) => ({ path: asString(v.path) }),
  },
  "lint-vault": {
    toolName: "lint_vault",
    toolFn: lintVault as unknown as ToolFn,
    parse: {
      ...COMMON,
      prefix: { type: "string" },
      limit: { type: "string" },
    },
    buildArgs: (v) => {
      const args: Record<string, unknown> = {};
      const prefix = optionalString(v.prefix);
      if (prefix) args.prefix = prefix;
      const limit = optionalString(v.limit);
      if (limit) args.limit = Number(limit);
      return args;
    },
  },
  "lint-vault-autofix": {
    toolName: "lint_vault_autofix",
    toolFn: lintVaultAutofix as unknown as ToolFn,
    parse: {
      ...COMMON,
      yes: { type: "boolean" },
    },
    buildArgs: (v) => {
      // Dry-run unless --yes was passed. The tool defaults to dry-run
      // internally too — belt-and-suspenders.
      return v.yes ? { dry_run: false } : { dry_run: true };
    },
  },
};

function formatReadOutput(result: unknown, wantJson: boolean): string {
  // Structured reads: default to unwrapped MCP text (already-parsed JSON or
  // raw text); --json gives the parsed JSON representation.
  const withContent = result as { content?: Array<{ type: string; text?: string }> };
  const text = withContent.content?.[0]?.text;
  if (typeof text !== "string") return JSON.stringify(result, null, 2);
  if (wantJson) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }
  return text;
}

async function runStructuredRead(verbName: string, argv: string[]): Promise<void> {
  const spec = READ_VERBS[verbName];
  if (!spec) throw new Error(`unknown read verb: ${verbName}`);
  const { values: raw } = parseArgs({ args: argv, options: spec.parse, strict: true });
  const values = raw as unknown as Record<string, string | boolean | undefined>;
  const args = spec.buildArgs(values);
  const remote = Boolean(values.remote);
  const wantJson = Boolean(values.json);
  const noCache = Boolean(values["no-cache"]);

  // SPRINT-128: cache hit path.
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
  if (!cacheHit) {
    result = remote
      ? await callTool(spec.toolName, args)
      : await spec.toolFn({ mode: "local", docsDir }, args);
    if (isCacheable(spec.toolName)) {
      await writeCacheEntry(spec.toolName, args, remote, scope, result);
    }
  }

  const output = formatReadOutput(result, wantJson);
  process.stdout.write(output + (output.endsWith("\n") ? "" : "\n"));
}

// -------- legacy simple verbs (list, drift-batch) ---------

async function cmdList(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      prefix: { type: "string" },
      remote: { type: "boolean" },
    },
    strict: true,
  });
  const prefix = values.prefix ?? "";
  if (values.remote) {
    const args: Record<string, unknown> = { format: "text" };
    if (prefix) args.prefix = prefix;
    const result = await callTool("list_docs", args);
    const text = unwrapText(result);
    if (prefix) {
      for (const line of text.split("\n")) {
        if (line.startsWith(prefix)) process.stdout.write(line + "\n");
      }
    } else {
      process.stdout.write(text + (text.endsWith("\n") ? "" : "\n"));
    }
    return;
  }
  const idx = await buildIndex(docsDir);
  for (const d of idx.docs) {
    if (!prefix || d.path.startsWith(prefix)) process.stdout.write(d.path + "\n");
  }
}

async function cmdDriftBatch(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      limit: { type: "string", default: "10" },
      offset: { type: "string", default: "0" },
      prefix: { type: "string" },
      remote: { type: "boolean" },
    },
    strict: true,
  });
  const limit = Math.max(1, Number(values.limit) | 0);
  const offset = Math.max(0, Number(values.offset) | 0);
  if (values.remote) {
    const args: Record<string, unknown> = { limit, offset };
    if (values.prefix) args.prefix = values.prefix;
    const result = await callTool("list_summary_drift", args);
    const text = unwrapText(result);
    process.stdout.write(text + (text.endsWith("\n") ? "" : "\n"));
    return;
  }
  const idx = await buildIndex(docsDir);
  const filtered = idx.docs
    .filter((d) => !values.prefix || d.path.startsWith(values.prefix))
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(offset, offset + limit);
  for (const d of filtered) {
    process.stdout.write(`--- ${d.path}\n`);
    process.stdout.write(`${d.summary ?? ""}\n\n`);
    process.stdout.write(`${d.content}\n\n`);
  }
}

// get-image needs a bespoke handler: the tool returns a two-part content
// block (text metadata + image data). Default output is the metadata JSON;
// with --out, decode the base64 and write the binary to a file.
async function cmdGetImage(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      "doc-path": { type: "string" },
      out: { type: "string" },
      remote: { type: "boolean" },
      json: { type: "boolean" },
    },
    strict: true,
  });
  const docPath = asString(values["doc-path"]);
  if (!docPath) {
    process.stderr.write("get-image: --doc-path required\n");
    process.exit(1);
  }
  const args = { doc_path: docPath };
  const result = values.remote
    ? await callTool("get_image", args)
    : await (getImage as unknown as ToolFn)({ mode: "local", docsDir }, args);

  const content = (result as { content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }> }).content ?? [];
  const meta = content.find((c) => c.type === "text");
  const image = content.find((c) => c.type === "image");
  const metaParsed = meta?.text ? JSON.parse(meta.text) : {};

  if (image?.data && values.out) {
    const outPath = path.resolve(values.out);
    writeFileSync(outPath, Buffer.from(image.data, "base64"));
    process.stdout.write(`Saved ${image.data.length} base64 bytes (${image.mimeType}) to ${outPath}\n`);
    return;
  }

  const payload = {
    ...metaParsed,
    mime_type: image?.mimeType,
    size_bytes: image?.data ? Buffer.from(image.data, "base64").byteLength : 0,
  };
  process.stdout.write(JSON.stringify(payload, null, values.json ? 2 : 0) + "\n");
}

const [, , sub, ...rest] = process.argv;

async function main(): Promise<void> {
  if (sub === "list") return cmdList(rest);
  if (sub === "drift-batch") return cmdDriftBatch(rest);
  if (sub === "get-image") return cmdGetImage(rest);
  if (sub && READ_VERBS[sub]) return runStructuredRead(sub, rest);
  process.stderr.write(`unknown read subcommand: ${sub ?? "(none)"}\n`);
  process.stderr.write(`verbs: list, drift-batch, get-image, ${Object.keys(READ_VERBS).join(", ")}\n`);
  process.exit(1);
}

main().catch((err) => {
  if (err instanceof NeedsLoginError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
