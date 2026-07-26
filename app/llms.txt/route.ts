// SPRINT-149: llms.txt — the emerging convention (parallel to robots.txt)
// for telling LLM crawlers where the canonical machine-readable docs live.
// See https://llmstxt.org/ for the spec.

export const runtime = "edge";

const BODY = `# EMDEE

> Local-first knowledge graph in plain markdown. Built-in MCP server exposes read/write tools to AI agents (Claude, ChatGPT, Cursor, and any MCP-compatible client). Designed for multi-agent safe writes via optimistic concurrency control.

## Product

- [Homepage](https://emdee.tech/)
- [Public vault (live graph example)](https://emdee.tech/vault)
- [GitHub source](https://github.com/AISystemResources/emdee)
- [npm package](https://www.npmjs.com/package/@aisystemresources/emdee)

## Getting started for AI agents

- MCP HTTP endpoint (authenticated): https://emdee.tech/api/mcp
- MCP stdio (via CLI): \`npm i -g @aisystemresources/emdee && emdee mcp\`
- OAuth flow for MCP clients: https://emdee.tech/oauth/authorize

## Concepts

- Every doc is a plain markdown file with H1 title + \`> blockquote\` summary + \`## Child of\` / \`## Parent of\` / \`## Associated with\` sections.
- Edges are stored in a materialised \`doc_edges\` table for fast graph queries.
- Every write tool accepts an optional \`expected_content_hash\` for version-guarded (multi-agent safe) writes.

## Positioning

Not a replacement for Obsidian for solo human note-taking. Purpose-built for the case where an AI agent needs to reliably read, extend, and reason over a knowledge graph without silently corrupting it.
`;

export async function GET() {
  return new Response(BODY, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
