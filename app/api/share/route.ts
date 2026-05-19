import { auth } from "@clerk/nextjs/server";
import { adminClient } from "@/src/lib/supabase/admin";
import { ensureProfile } from "@/src/lib/supabase/oauth";
import { SupabaseStorage } from "@/src/lib/storage/SupabaseStorage";
import { buildIndexFromContents } from "@/src/core/indexer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface ShareRow {
  id: string;
  grantee_id: string;
  path_prefix: string;
  permission: "read" | "write";
  created_at: string;
  grantee?: { email: string | null } | { email: string | null }[] | null;
}

interface InviteRow {
  id: string;
  invitee_email: string;
  path_prefix: string;
  permission: "read" | "write";
  created_at: string;
  token: string;
}

/**
 * Lists shares + pending invitations whose root is this path. A row matches
 * when path_prefix == path OR share_root == path — that way, opening the
 * share modal on a cascade root surfaces the single group entry per
 * recipient, and opening it on a single-doc share still works.
 *
 * Output is deduped by recipient: one row per (grantee/email, share_root or
 * path_prefix) with a doc_count so the UI can render "user@x.com (N docs)".
 */
export async function GET(request: Request) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const path = url.searchParams.get("path");
  if (!path) return Response.json({ error: "path required" }, { status: 400 });

  const admin = adminClient();
  const [{ data: shares }, { data: invites }, { data: pub }, { data: profile }] = await Promise.all([
    admin
      .from("doc_shares")
      .select("id, grantee_id, path_prefix, share_root, permission, created_at, grantee:profiles!doc_shares_grantee_id_fkey(email)")
      .eq("owner_id", userId)
      .or(`path_prefix.eq.${path},share_root.eq.${path}`)
      .order("created_at", { ascending: false }),
    admin
      .from("share_invitations")
      .select("id, invitee_email, path_prefix, share_root, permission, created_at, token")
      .eq("inviter_id", userId)
      .or(`path_prefix.eq.${path},share_root.eq.${path}`)
      .eq("status", "pending")
      .order("created_at", { ascending: false }),
    admin
      .from("publications")
      .select("id, slug, root_doc_path, include_descendants, include_direct_associates, included_paths, created_at, updated_at")
      .eq("owner_id", userId)
      .eq("root_doc_path", path)
      .maybeSingle(),
    admin
      .from("profiles")
      .select("handle")
      .eq("clerk_id", userId)
      .maybeSingle(),
  ]);

  // Group shares by (grantee_id, group_key) where group_key = share_root if
  // present else path_prefix. Pick a representative row id for revoke calls.
  const shareGroups = new Map<string, ReturnType<typeof formatShare>>();
  type ShareWithRoot = ShareRow & { share_root: string | null };
  for (const s of (shares ?? []) as ShareWithRoot[]) {
    const groupKey = s.share_root ?? s.path_prefix;
    const key = `${s.grantee_id}::${groupKey}`;
    const existing = shareGroups.get(key);
    if (existing) {
      existing.doc_count += 1;
    } else {
      shareGroups.set(key, formatShare(s, groupKey, 1));
    }
  }
  const inviteGroups = new Map<string, ReturnType<typeof formatInvite>>();
  type InviteWithRoot = InviteRow & { share_root: string | null };
  for (const i of (invites ?? []) as InviteWithRoot[]) {
    const groupKey = i.share_root ?? i.path_prefix;
    const key = `${i.invitee_email.toLowerCase()}::${groupKey}`;
    const existing = inviteGroups.get(key);
    if (existing) {
      existing.doc_count += 1;
    } else {
      inviteGroups.set(key, formatInvite(i, groupKey, 1));
    }
  }

  const publication = pub
    ? {
        id: pub.id,
        slug: pub.slug,
        handle: profile?.handle ?? null,
        url: profile?.handle ? `/share/${profile.handle}/${pub.slug}` : null,
        include_descendants: pub.include_descendants,
        include_direct_associates: pub.include_direct_associates,
        included_count: (pub.included_paths ?? []).length,
        updated_at: pub.updated_at,
      }
    : null;

  return Response.json({
    shares: Array.from(shareGroups.values()),
    invitations: Array.from(inviteGroups.values()),
    publication,
    owner_handle: profile?.handle ?? null,
  });
}

function formatShare(s: ShareRow & { share_root: string | null }, groupKey: string, doc_count: number) {
  const g = Array.isArray(s.grantee) ? s.grantee[0] : s.grantee;
  return {
    id: s.id,
    kind: "share" as const,
    grantee_id: s.grantee_id,
    email: g?.email ?? null,
    permission: s.permission,
    created_at: s.created_at,
    share_root: groupKey,
    doc_count,
  };
}
function formatInvite(i: InviteRow & { share_root: string | null }, groupKey: string, doc_count: number) {
  return {
    id: i.id,
    kind: "invitation" as const,
    email: i.invitee_email,
    permission: i.permission,
    token: i.token,
    created_at: i.created_at,
    share_root: groupKey,
    doc_count,
  };
}

/**
 * Walk hierarchy edges from `rootPath` to collect every descendant path
 * (Parent of / Child of). The root itself is included as the first entry.
 * Uses the same indexer the runtime uses so the share view matches the
 * sidebar tree the owner sees.
 */
async function collectCascadePaths(ownerId: string, rootPath: string): Promise<string[]> {
  const storage = new SupabaseStorage();
  const listed = await storage.list(`${ownerId}/`);
  const files = await Promise.all(
    listed.map(async (f) => ({
      path: f.path.slice(`${ownerId}/`.length),
      content: (await storage.read(f.path)) ?? "",
    }))
  );
  const index = buildIndexFromContents(files);

  // child adjacency from hierarchy edges (parent → children)
  const children = new Map<string, string[]>();
  for (const e of index.edges) {
    if (e.kind !== "hierarchy") continue;
    const arr = children.get(e.from) ?? [];
    arr.push(e.to);
    children.set(e.from, arr);
  }

  const out: string[] = [];
  const visited = new Set<string>();
  const walk = (p: string) => {
    if (visited.has(p)) return;
    visited.add(p);
    out.push(p);
    for (const c of children.get(p) ?? []) walk(c);
  };
  walk(rootPath);
  return out;
}

/**
 * Share or invite. Cascades through hierarchy by default — the focal path
 * plus every descendant gets its own row tagged with share_root=focal so
 * the group can be revoked in one click. Pass cascade=false to share only
 * the focal doc.
 *
 * If the email matches an existing profile, doc_shares rows are created;
 * otherwise share_invitations rows are stored pending and auto-claimed on
 * the invitee's signup (see ensureProfile).
 */
export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  if (!body || typeof body.path !== "string" || typeof body.email !== "string") {
    return Response.json({ error: "path and email required" }, { status: 400 });
  }
  const path = body.path.trim();
  const email = body.email.trim().toLowerCase();
  const permission: "read" | "write" = body.permission === "write" ? "write" : "read";
  const cascade: boolean = body.cascade !== false;

  if (!email.includes("@")) return Response.json({ error: "invalid email" }, { status: 400 });

  await ensureProfile(userId);

  const paths = cascade
    ? await collectCascadePaths(userId, path)
    : [path];

  const admin = adminClient();
  const { data: match } = await admin
    .from("profiles")
    .select("clerk_id, email")
    .ilike("email", email)
    .maybeSingle();

  if (match) {
    if (match.clerk_id === userId) {
      return Response.json({ error: "cannot share with yourself" }, { status: 400 });
    }
    const rows = paths.map((p) => ({
      owner_id: userId,
      grantee_id: match.clerk_id,
      path_prefix: p,
      permission,
      share_root: cascade ? path : null,
    }));
    const { error } = await admin
      .from("doc_shares")
      .upsert(rows, { onConflict: "owner_id,path_prefix,grantee_id" });
    if (error) return Response.json({ error: error.message }, { status: 500 });
    return Response.json({ kind: "share", count: rows.length, email: match.email });
  }

  // Non-user invitee — pre-stage one invitation row per path so the cascade
  // materializes correctly on signup.
  const rows = paths.map((p) => ({
    inviter_id: userId,
    invitee_email: email,
    path_prefix: p,
    permission,
    share_root: cascade ? path : null,
  }));
  const { error } = await admin
    .from("share_invitations")
    .insert(rows);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ kind: "invitation", count: rows.length, email });
}
