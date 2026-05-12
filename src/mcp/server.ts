import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import path from "node:path";
import {
  listDocs,
  getSummary,
  getNeighbors,
  getDoc,
  search,
  appendSection,
  patchSection,
  writeDocPreview,
  writeDoc,
} from "../lib/mcp/tools/index.js";
import type { ToolContext } from "../lib/mcp/tools/types.js";

const docsDir = path.resolve(process.env.EMDEE_DOCS ?? path.join(process.cwd(), "docs"));
const ctx: ToolContext = { docsDir };

const server = new Server(
  {
    name: "emdee",
    version: "0.0.1",
  },
  {
    capabilities: { tools: {} },
    instructions: `You are working inside a Emdee vault — a plain-markdown knowledge graph.

BEFORE writing or editing any doc:
1. Call get_doc("INFO.md") to load vault conventions (doc structure, naming rules, relationship sections).
2. If working on a specific project, call get_doc on that project's INSTRUCTIONS.md first (e.g. get_doc("projects/ATLAS/INSTRUCTIONS.md")).
3. Use patch_section for incremental edits — never write_doc for single-section changes.

Key conventions:
- Every doc starts with one H1 + one > blockquote summary immediately below it. No summary = invisible to get_summary.
- Sprints: Child of [[PROJECT — BUILD]] if active/spec, Child of [[PROJECT — LOGS]] if shipped. Change this when a sprint closes.
- Learnings: individual files under learnings/, Child of [[PROJECT — LEARNINGS]]. LEARNINGS.md is a thin index only.
- Relationships: Parent of / Child of = taxonomy. Associated with = everything else.`,
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_docs",
      description:
        "Enumerate every doc in the vault as {path, title, summary}. Cheap entry point — call this first when starting cold to see what exists.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_summary",
      description:
        "Return {path, title, summary} for one doc. Use this when you know which doc to look at but don't want to spend tokens on the full body yet.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Relative path of the doc, e.g. people/KIRAN.md" } },
        required: ["path"],
      },
    },
    {
      name: "get_neighbors",
      description:
        "Return the doc plus its 1-hop neighborhood, categorized by relationship type. Each neighbor is {path, title, summary, note}. `note` is the prose written next to the wiki-link on the declaring side — read it for relationship context. Also returns `mentioned_in`: docs that reference this one in prose without declaring a relationship.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    {
      name: "get_doc",
      description:
        "Return the full markdown content of one doc plus a `sections` array with each H2 section's content_hash. Use the hashes for follow-up patch_section calls. More expensive — only call after deciding (via summary or neighbors) that the full body is needed.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    {
      name: "search",
      description:
        "Case-insensitive substring search over titles, summaries, and full content. Returns top matches as {path, title, summary, snippet}. Use this for cold starts when there is no known path.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number", description: "Max results (default 10)" },
        },
        required: ["query"],
      },
    },
    {
      name: "append_section",
      description:
        "Append markdown content to the end of an existing H2 section. Section-scoped — safer than write_doc for incremental edits. Pass create_if_missing=true to add a new H2 section at the end of the file if the heading doesn't exist (default false, returns section_not_found error). Returns the new content_hash of the section for follow-up patches.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          heading: { type: "string", description: "H2 heading text without the `## ` prefix" },
          body: { type: "string", description: "Markdown body to append to the section" },
          create_if_missing: {
            type: "boolean",
            description: "If true, create the section at end of file when heading is not found. Default false.",
          },
        },
        required: ["path", "heading", "body"],
      },
    },
    {
      name: "patch_section",
      description:
        "Replace the body of an existing H2 section. Version-guarded: pass expected_content_hash from a prior get_doc, append_section, or patch_section response. Mismatch returns a structured version_conflict error with the actual hash so you can re-read and reconcile. This is the ONLY safe path for destructive section edits — never use write_doc for incremental edits, it replaces the entire file and silently loses content.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          heading: { type: "string", description: "H2 heading text without the `## ` prefix" },
          body: { type: "string", description: "New body content for the section" },
          expected_content_hash: {
            type: "string",
            description: "Short hash of the section's current body (from get_doc.sections or a previous mutation's response).",
          },
        },
        required: ["path", "heading", "body", "expected_content_hash"],
      },
    },
    {
      name: "write_doc_preview",
      description:
        "Preview the diff that write_doc would produce. ALWAYS call this before write_doc — write_doc replaces the entire file and silently destroys sections not present in the new payload. If the change is section-scoped, prefer append_section or patch_section instead.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string", description: "Proposed new content for the entire file" },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "write_doc",
      description:
        "Create or overwrite a markdown doc at the given relative path. DESTRUCTIVE — full-file replacement, silently deletes any content not in the new payload. Use append_section or patch_section for incremental edits. Always run write_doc_preview first to see what would be lost.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
  const { name, arguments: args } = req.params;
  const a = args ?? {};

  switch (name) {
    case "list_docs":         return await listDocs(ctx, a) as CallToolResult;
    case "get_summary":       return await getSummary(ctx, a) as CallToolResult;
    case "get_neighbors":     return await getNeighbors(ctx, a) as CallToolResult;
    case "get_doc":           return await getDoc(ctx, a) as CallToolResult;
    case "search":            return await search(ctx, a) as CallToolResult;
    case "append_section":    return await appendSection(ctx, a) as CallToolResult;
    case "patch_section":     return await patchSection(ctx, a) as CallToolResult;
    case "write_doc_preview": return await writeDocPreview(ctx, a) as CallToolResult;
    case "write_doc":         return await writeDoc(ctx, a) as CallToolResult;
    default:
      throw new Error(`unknown tool: ${name}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
