// SPRINT-188: shared admin-role check used by /admin/* pages AND the
// admin-view read bypass on /api/index and /api/doc. Single source of
// truth so read-side and page-side stay in lockstep.
//
// Rule: admins can READ any namespace; admins CANNOT WRITE any other
// namespace. Writes on /api/doc PUT and every MCP tool remain strictly
// self-only. See the SPRINT-188 spec + user directive 2026-08-07:
// "the MCP and CLI should not have any tools to touch other people's
// vault, even if it's admin."

import { adminClient } from "./supabase/admin";

export async function isAdminUser(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  const { data } = await adminClient()
    .from("profiles")
    .select("is_admin")
    .eq("clerk_id", userId)
    .maybeSingle();
  return !!data?.is_admin;
}

/**
 * Log an admin viewing a specific user's vault. Even with consent,
 * every admin view leaves a breadcrumb — so if a user ever asks
 * "did you look at my vault?" the answer is honest and auditable.
 * Best-effort — a logging failure doesn't block the view.
 */
export async function logAdminVaultView(
  adminUserId: string,
  targetNamespace: string,
  docPath: string | null,
): Promise<void> {
  try {
    await adminClient().from("mcp_activity").insert({
      namespace: targetNamespace,
      clerk_id: adminUserId,
      tool_name: "admin_view",
      doc_path: docPath,
      action_kind: "read",
      args_summary: { admin_view: true, viewer_clerk_id: adminUserId },
    });
  } catch (e) {
    console.error(`admin view log failed for ${adminUserId} → ${targetNamespace}:`, e);
  }
}
