// OpenAPI 3.1 discovery surface for the Emdee REST API.
//
// Returned by GET /api/rest/openapi as a JSON document — Coze / GPT Actions /
// Doubao / any other HTTP-plugin builder reads this to auto-configure their
// tool. The endpoint itself is PUBLIC (no auth) and cached on the CDN for
// 5 minutes; the API surface it describes requires a Bearer token (same
// OAuth 2.1 access token system as the MCP server).

import { withCors, corsPreflight } from "@/src/lib/rest/responses";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function OPTIONS(): Promise<Response> {
  return corsPreflight();
}

const SPEC = {
  openapi: "3.1.0",
  info: {
    title: "Emdee REST API",
    version: "0.1.0",
    description:
      "REST surface over the Emdee vault. Reuses the same OAuth token system as the MCP server — a token minted via the claude.ai OAuth flow works here too. Email-based access control (doc_shares) governs cross-namespace access.",
  },
  servers: [{ url: "https://emdee.vercel.app", description: "Production" }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "OAuth 2.1 access token",
      },
    },
    schemas: {
      DocSummary: {
        type: "object",
        properties: {
          path: { type: "string", description: "Vault-relative path, e.g. `projects/SAIVERS.md`." },
          title: { type: "string", description: "Document H1." },
          summary: { type: "string", description: "Blockquote summary immediately below the H1." },
        },
        required: ["path", "title", "summary"],
      },
      Section: {
        type: "object",
        properties: {
          heading: { type: "string", description: "Section heading text (without leading `#`s)." },
          content_hash: {
            type: "string",
            description: "Hash of the section body — pass as `expected_content_hash` on PATCH to detect concurrent edits.",
          },
        },
        required: ["heading", "content_hash"],
      },
      Preamble: {
        type: "object",
        description: "The H1 + blockquote region at the top of the doc, above any section heading.",
        properties: {
          body: { type: "string" },
          content_hash: { type: "string" },
        },
        required: ["body", "content_hash"],
      },
      DocFull: {
        type: "object",
        properties: {
          path: { type: "string" },
          title: { type: "string" },
          summary: { type: "string" },
          content: { type: "string", description: "Full markdown body of the document." },
          sections: { type: "array", items: { $ref: "#/components/schemas/Section" } },
          preamble: {
            anyOf: [{ $ref: "#/components/schemas/Preamble" }, { type: "null" }],
          },
        },
        required: ["path", "title", "summary", "content", "sections", "preamble"],
      },
      SearchResult: {
        type: "object",
        properties: {
          path: { type: "string" },
          title: { type: "string" },
          summary: { type: "string" },
          snippet: { type: "string", description: "Optional excerpt around the match." },
        },
        required: ["path", "title", "summary"],
      },
      ErrorResponse: {
        type: "object",
        properties: {
          ok: { type: "boolean", enum: [false] },
          error: {
            type: "string",
            description: "Stable error code, e.g. `unauthorized`, `forbidden`, `not_found`, `bad_request`, `conflict`.",
          },
          message: { type: "string", description: "Human-readable description." },
        },
        required: ["ok", "error"],
      },
    },
    parameters: {
      DocPath: {
        name: "path",
        in: "path",
        required: true,
        description: "Vault-relative path, may contain forward slashes, e.g. `projects/SAIVERS.md`.",
        style: "simple",
        explode: false,
        schema: { type: "string" },
      },
    },
    responses: {
      Unauthorized: {
        description: "Missing or invalid Bearer token.",
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
        },
      },
      Forbidden: {
        description: "Token is valid but lacks access to this resource.",
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
        },
      },
      NotFound: {
        description: "Resource not found.",
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
        },
      },
      BadRequest: {
        description: "Request was malformed or failed validation.",
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
        },
      },
      Conflict: {
        description: "Content hash mismatch — the section was edited since you last read it.",
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    "/api/rest/docs": {
      get: {
        tags: ["docs"],
        operationId: "listDocs",
        summary: "List all docs in the vault",
        description:
          "Returns a flat list of every doc the authenticated user can read (own vault + docs shared into it via doc_shares).",
        responses: {
          "200": {
            description: "List of doc summaries.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean", enum: [true] },
                    docs: { type: "array", items: { $ref: "#/components/schemas/DocSummary" } },
                  },
                  required: ["ok", "docs"],
                },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/api/rest/docs/{path}": {
      parameters: [{ $ref: "#/components/parameters/DocPath" }],
      get: {
        tags: ["docs"],
        operationId: "getDoc",
        summary: "Read a single doc",
        description:
          "Returns the full markdown content of a doc plus its parsed structure (preamble + sections with content hashes).",
        responses: {
          "200": {
            description: "Full doc payload.",
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    {
                      type: "object",
                      properties: { ok: { type: "boolean", enum: [true] } },
                      required: ["ok"],
                    },
                    { $ref: "#/components/schemas/DocFull" },
                  ],
                },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "403": { $ref: "#/components/responses/Forbidden" },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
      post: {
        tags: ["docs"],
        operationId: "writeDoc",
        summary: "Create or overwrite a doc",
        description:
          "Writes the full markdown body of a doc, creating it if missing. Shared docs (paths starting with `__shared__/`) are read-only and will return 403.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  content: { type: "string", description: "Full markdown body to write." },
                },
                required: ["content"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Doc written successfully.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean", enum: [true] },
                    path: { type: "string" },
                  },
                  required: ["ok", "path"],
                },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "403": { $ref: "#/components/responses/Forbidden" },
        },
      },
      patch: {
        tags: ["docs"],
        operationId: "patchSection",
        summary: "Patch a single section",
        description:
          "Replaces the body of one section, identified by heading. Requires the caller to send the `expected_content_hash` they read previously — if it no longer matches, the server returns 409 to prevent a clobber.",
        parameters: [
          {
            name: "section",
            in: "query",
            required: true,
            description: "Heading text of the section to patch (no leading `#`s).",
            schema: { type: "string" },
          },
          {
            name: "expected_content_hash",
            in: "query",
            required: true,
            description: "Content hash returned by GET — used for optimistic concurrency.",
            schema: { type: "string" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  body: { type: "string", description: "New markdown body for the section." },
                },
                required: ["body"],
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Section patched.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean", enum: [true] },
                    content_hash: { type: "string", description: "New content hash for the patched section." },
                  },
                  required: ["ok", "content_hash"],
                },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
          "404": { $ref: "#/components/responses/NotFound" },
          "409": { $ref: "#/components/responses/Conflict" },
        },
      },
    },
    "/api/rest/search": {
      get: {
        tags: ["search"],
        operationId: "searchDocs",
        summary: "Full-text search across the vault",
        description:
          "Searches doc titles, summaries, and bodies. Returns ranked matches with optional snippets.",
        parameters: [
          {
            name: "q",
            in: "query",
            required: true,
            description: "Search query string.",
            schema: { type: "string" },
          },
          {
            name: "limit",
            in: "query",
            required: false,
            description: "Maximum number of results to return (1-50).",
            schema: { type: "integer", minimum: 1, maximum: 50, default: 10 },
          },
        ],
        responses: {
          "200": {
            description: "Ranked search results.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean", enum: [true] },
                    query: { type: "string" },
                    results: {
                      type: "array",
                      items: { $ref: "#/components/schemas/SearchResult" },
                    },
                  },
                  required: ["ok", "query", "results"],
                },
              },
            },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
    "/api/rest/health": {
      get: {
        tags: ["health"],
        operationId: "health",
        summary: "Auth + vault health probe",
        description:
          "Confirms the Bearer token resolves to a user and reports basic vault stats. Useful for connection tests in plugin builders.",
        responses: {
          "200": {
            description: "Token is valid; vault is reachable.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean", enum: [true] },
                    userId: { type: "string" },
                    vaultDocCount: { type: "integer" },
                    timestamp: { type: "string", format: "date-time", description: "ISO 8601 timestamp." },
                  },
                  required: ["ok", "userId", "vaultDocCount", "timestamp"],
                },
              },
            },
          },
          "401": { $ref: "#/components/responses/Unauthorized" },
        },
      },
    },
  },
} as const;

export async function GET(): Promise<Response> {
  return withCors(
    Response.json(SPEC, { headers: { "cache-control": "public, max-age=300" } })
  );
}
