import { ctxFromAuthHeader } from "@/src/lib/rest/auth";
import {
  ok,
  unauthorized,
  badRequest,
  serverError,
  corsPreflight,
} from "@/src/lib/rest/responses";
import { search } from "@/src/lib/mcp/tools/search";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function OPTIONS() {
  return corsPreflight();
}

/**
 * GET /api/rest/search?q={query}&limit={n}
 *
 * Thin REST wrapper over the MCP `search` tool. Requires a Bearer token
 * resolvable to a vault-bound ToolContext. The MCP tool returns its
 * results as a JSON string wrapped in MCP content envelope — we parse
 * that out before re-emitting under the REST `{ ok, query, results }`
 * envelope.
 */
export async function GET(req: Request) {
  const ctx = await ctxFromAuthHeader(req);
  if (!ctx) return unauthorized();

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q) return badRequest("Missing required query parameter: q");

  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw
    ? Math.min(50, Math.max(1, parseInt(limitRaw, 10) || 10))
    : undefined;

  try {
    const wrapped = (await search(ctx, { query: q, limit })) as {
      content: Array<{ text: string }>;
    };
    const results = JSON.parse(wrapped.content[0].text);
    return ok({ query: q, results });
  } catch (e) {
    return serverError((e as Error).message);
  }
}
