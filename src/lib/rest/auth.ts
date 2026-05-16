import { clerkIdFromOAuthToken } from "@/src/lib/supabase/oauth";
import { SupabaseStorage } from "@/src/lib/storage/SupabaseStorage";
import type { ToolContext } from "@/src/lib/mcp/tools/types";

/**
 * Resolve a REST request's `Authorization: Bearer <token>` header to a
 * vault-bound ToolContext. The same `oauth_tokens` table the MCP uses
 * backs both surfaces — a token minted by the claude.ai OAuth flow is
 * therefore valid for REST too, and the per-token Clerk identity drives
 * the existing ACL checks in [[doc_shares]].
 *
 * Returns null when the token is missing, malformed, or expired. The
 * route handler converts that into a 401 via {@link unauthorized}.
 */
export async function ctxFromAuthHeader(req: Request): Promise<ToolContext | null> {
  const clerkId = await clerkIdFromOAuthToken(req);
  if (!clerkId) return null;
  return { mode: "cloud", storage: new SupabaseStorage(), userId: clerkId };
}
