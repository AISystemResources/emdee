import { auth } from "@clerk/nextjs/server";
import { adminClient } from "@/src/lib/supabase/admin";
import { SupabaseStorage } from "@/src/lib/storage/SupabaseStorage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface ShareRow {
  id: string;
  owner_id: string;
  path_prefix: string;
  permission: "read" | "write";
  owner: { email: string | null } | { email: string | null }[] | null;
}

function extractTitle(content: string, fallbackPath: string): string {
  const m = content.match(/^#\s+(.+)$/m);
  if (m) return m[1].trim();
  const base = fallbackPath.split("/").pop() ?? fallbackPath;
  return base.replace(/\.md$/, "");
}

/**
 * Docs shared with the requesting user. Returns each shared doc's content so
 * the client can render it directly without paying a second round-trip per
 * doc. path_prefix is treated as an exact path in this MVP — folder-level
 * prefixes are stored but not yet expanded.
 */
export async function GET() {
  const { userId } = await auth();
  if (!userId) return Response.json({ docs: [] });

  const admin = adminClient();
  const { data, error } = await admin
    .from("doc_shares")
    .select("id, owner_id, path_prefix, permission, owner:profiles!doc_shares_owner_id_fkey(email)")
    .eq("grantee_id", userId)
    .order("created_at", { ascending: false });

  if (error) return Response.json({ docs: [], error: error.message }, { status: 500 });

  const storage = new SupabaseStorage();
  const rows = (data ?? []) as ShareRow[];

  const docs = await Promise.all(
    rows.map(async (r) => {
      const owner = Array.isArray(r.owner) ? r.owner[0] : r.owner;
      const fullPath = `${r.owner_id}/${r.path_prefix}`;
      const content = (await storage.read(fullPath).catch(() => null)) ?? "";
      return {
        shareId: r.id,
        ownerId: r.owner_id,
        ownerEmail: owner?.email ?? null,
        path: r.path_prefix,
        title: extractTitle(content, r.path_prefix),
        content,
        permission: r.permission,
      };
    })
  );

  return Response.json({ docs });
}
