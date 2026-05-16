import { ctxFromAuthHeader } from "@/src/lib/rest/auth";
import {
  ok,
  unauthorized,
  serverError,
  corsPreflight,
} from "@/src/lib/rest/responses";
import { loadVaultIndex } from "@/src/lib/mcp/tools/vault";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function OPTIONS() {
  return corsPreflight();
}

/**
 * GET /api/rest/health
 *
 * Authenticated heartbeat. A successful response confirms three things at
 * once: the caller's Bearer token resolves to a Clerk identity, vault
 * storage is reachable, and the indexer can build a view of the vault.
 * Returns the resolved userId, the number of docs visible to that user
 * (own + shared), and a server-side timestamp.
 */
export async function GET(req: Request) {
  const ctx = await ctxFromAuthHeader(req);
  if (!ctx) return unauthorized();

  // ctxFromAuthHeader always builds a cloud-mode ToolContext, but the
  // ToolContext union also has a local variant — narrow before reading
  // userId so TS is happy.
  if (ctx.mode !== "cloud") return serverError("Unexpected context mode");

  try {
    const index = await loadVaultIndex(ctx);
    return ok({
      userId: ctx.userId,
      vaultDocCount: index.docs.length,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    return serverError((e as Error).message);
  }
}
