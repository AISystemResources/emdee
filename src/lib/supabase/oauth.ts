import { clerkClient } from "@clerk/nextjs/server";
import { adminClient, hashToken } from "./admin";
import { deriveHandleFromEmail } from "@/src/lib/owner/handle";

const TOKEN_TTL_DAYS = 30;
const CODE_TTL_MINUTES = 10;

export async function registerClient(clientName: string | null, redirectUris: string[]): Promise<string> {
  const { data, error } = await adminClient()
    .from("oauth_clients")
    .insert({ client_name: clientName, redirect_uris: redirectUris })
    .select("client_id")
    .single();
  if (error || !data) throw new Error(error?.message ?? "failed to register client");
  return data.client_id;
}

export async function getClient(clientId: string): Promise<{ client_id: string; client_name: string | null; redirect_uris: string[] } | null> {
  const { data } = await adminClient()
    .from("oauth_clients")
    .select("client_id, client_name, redirect_uris")
    .eq("client_id", clientId)
    .maybeSingle();
  return data ?? null;
}

function generateCode(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function fetchClerkEmail(clerkId: string): Promise<string | null> {
  try {
    const client = await clerkClient();
    const user = await client.users.getUser(clerkId);
    const primary = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId);
    return primary?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? null;
  } catch {
    return null;
  }
}

/**
 * When a profile gets an email for the first time, look up any pending
 * share_invitations addressed to that email and convert them into doc_shares
 * (then mark the invitations accepted). This is what makes "invite by email
 * before signup" actually deliver access once the invitee joins.
 */
async function claimPendingInvitations(clerkId: string, email: string): Promise<void> {
  const admin = adminClient();
  const { data: invites } = await admin
    .from("share_invitations")
    .select("id, inviter_id, path_prefix, permission, share_root")
    .eq("status", "pending")
    .ilike("invitee_email", email);
  if (!invites || invites.length === 0) return;

  const rows = invites.map((inv) => ({
    owner_id: inv.inviter_id,
    grantee_id: clerkId,
    path_prefix: inv.path_prefix,
    permission: inv.permission,
    share_root: inv.share_root,
  }));
  await admin.from("doc_shares").upsert(rows, {
    onConflict: "owner_id,path_prefix,grantee_id",
    ignoreDuplicates: true,
  });
  await admin
    .from("share_invitations")
    .update({ status: "accepted", accepted_at: new Date().toISOString() })
    .in("id", invites.map((i) => i.id));
}

/**
 * Recursively moves all Storage files under oldPrefix/ to newPrefix/ using
 * the server-side move API (no download/upload — metadata rename only).
 */
async function moveStoragePrefix(oldPrefix: string, newPrefix: string, sub = ""): Promise<void> {
  const folder = sub ? `${oldPrefix}/${sub}` : oldPrefix;
  const { data: items } = await adminClient().storage.from("vaults").list(folder, { limit: 1000 });
  if (!items) return;
  for (const item of items) {
    const oldPath = sub ? `${oldPrefix}/${sub}/${item.name}` : `${oldPrefix}/${item.name}`;
    const newPath = sub ? `${newPrefix}/${sub}/${item.name}` : `${newPrefix}/${item.name}`;
    if (!item.id) {
      // folder — recurse
      await moveStoragePrefix(oldPrefix, newPrefix, sub ? `${sub}/${item.name}` : item.name);
    } else {
      const { error } = await adminClient().storage.from("vaults").move(oldPath, newPath);
      if (error) console.warn(`storage move failed ${oldPath}: ${error.message}`);
    }
  }
}

/**
 * When a new Clerk ID signs in with an email that already has a profile row
 * (from a prior Clerk instance), remap every table that uses clerk_id as a
 * key so all existing vault data appears under the new ID.
 *
 * Handles: profiles (PK), doc_shares, oauth_tokens, sync_manifest, oauth_codes,
 * share_invitations, publications, subscriptions, publication_events (FK tables),
 * plus doc_edges, vault_files, mcp_activity (plain-text namespace fields),
 * plus the Storage vaults bucket folder (server-side move, no data transfer).
 */
async function migrateClerkInstance(devId: string, prodId: string): Promise<void> {
  const admin = adminClient();

  // Remove any rows auto-created for the new ID so inserts below don't conflict.
  await admin.from("vault_files").delete().eq("namespace", prodId);
  await admin.from("doc_edges").delete().eq("namespace", prodId);
  await admin.from("mcp_activity").delete().eq("clerk_id", prodId);
  // Cascade-deletes FK children (doc_shares, sync_manifest, oauth_*, publications, subscriptions).
  await admin.from("profiles").delete().eq("clerk_id", prodId);

  // Insert prod profile, preserving vault_id + email + created_at from dev row.
  const { data: devProfile } = await admin
    .from("profiles")
    .select("vault_id, email, created_at")
    .eq("clerk_id", devId)
    .single();
  if (!devProfile) return;
  await admin.from("profiles").insert({
    clerk_id: prodId,
    vault_id: devProfile.vault_id,
    email: devProfile.email,
    created_at: devProfile.created_at,
  });

  // Update FK tables (prod profile now exists, so FK checks pass).
  await admin.from("doc_shares").update({ owner_id: prodId }).eq("owner_id", devId);
  await admin.from("doc_shares").update({ grantee_id: prodId }).eq("grantee_id", devId);
  await admin.from("oauth_tokens").update({ clerk_id: prodId }).eq("clerk_id", devId);
  await admin.from("sync_manifest").update({ clerk_id: prodId }).eq("clerk_id", devId);
  await admin.from("oauth_codes").update({ clerk_id: prodId }).eq("clerk_id", devId);
  await admin.from("share_invitations").update({ inviter_id: prodId }).eq("inviter_id", devId);
  await admin.from("publications").update({ owner_id: prodId }).eq("owner_id", devId);
  await admin.from("subscriptions").update({ subscriber_id: prodId }).eq("subscriber_id", devId);
  await admin.from("publication_events").update({ viewer_user_id: prodId }).eq("viewer_user_id", devId);

  // Update plain-text namespace fields.
  await admin.from("doc_edges").update({ namespace: prodId }).eq("namespace", devId);
  await admin.from("vault_files").update({ namespace: prodId }).eq("namespace", devId);
  await admin.from("mcp_activity")
    .update({ namespace: prodId, clerk_id: prodId })
    .eq("clerk_id", devId);

  // user_activity_stats (clerk_id PK — delete prod row first, then remap dev row)
  await admin.from("user_activity_stats").delete().eq("clerk_id", prodId);
  await admin.from("user_activity_stats").update({ clerk_id: prodId }).eq("clerk_id", devId);

  // Remove the now-orphaned dev profile.
  await admin.from("profiles").delete().eq("clerk_id", devId);

  // Rename the Storage folder — server-side move, no download/upload.
  await moveStoragePrefix(devId, prodId);
}

/**
 * Ensure a profiles row exists for this clerk_id so FK-bearing inserts succeed.
 * Also backfills email from Clerk if the existing row has none — needed for
 * email-based sharing lookups — and claims any pending share invitations
 * addressed to that email.
 *
 * If the Clerk email matches an existing profile with a different clerk_id, this
 * is a Clerk-instance migration (dev → prod). We remap all data to the new ID
 * automatically instead of creating a new empty profile.
 */
export async function ensureProfile(clerkId: string): Promise<void> {
  const admin = adminClient();
  const { data: existing } = await admin
    .from("profiles")
    .select("clerk_id, email")
    .eq("clerk_id", clerkId)
    .maybeSingle();

  if (existing?.email) return;

  const email = await fetchClerkEmail(clerkId);

  if (email) {
    const { data: priorProfile } = await admin
      .from("profiles")
      .select("clerk_id")
      .eq("email", email)
      .neq("clerk_id", clerkId)
      .maybeSingle();

    if (priorProfile) {
      await migrateClerkInstance(priorProfile.clerk_id, clerkId);
      return;
    }
  }

  const row: { clerk_id: string; email?: string; handle?: string } = { clerk_id: clerkId };
  if (email) {
    row.email = email;
    const derived = await pickAvailableHandle(admin, email);
    if (derived) row.handle = derived;
  }

  const { error } = await admin
    .from("profiles")
    .upsert(row, { onConflict: "clerk_id" });
  if (error) throw new Error(`failed to ensure profile: ${error.message}`);

  if (email) await claimPendingInvitations(clerkId, email);
}

/**
 * Best-effort handle from email, with collision-suffix fallback (`-2`, `-3`, …).
 * Returns null if we can't derive anything usable — signup still succeeds; the
 * user can set a handle later via `PATCH /api/profile/handle`.
 */
async function pickAvailableHandle(
  admin: ReturnType<typeof adminClient>,
  email: string,
): Promise<string | null> {
  const base = deriveHandleFromEmail(email);
  if (!base) return null;
  for (let n = 1; n <= 50; n += 1) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (candidate.length > 32) return null;
    const { data } = await admin
      .from("profiles")
      .select("clerk_id")
      .eq("handle", candidate)
      .maybeSingle();
    if (!data) return candidate;
  }
  return null;
}

export async function storeAuthCode(params: {
  clientId: string;
  clerkId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
}): Promise<string> {
  await ensureProfile(params.clerkId);
  const code = generateCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString();
  const { error } = await adminClient().from("oauth_codes").insert({
    code,
    client_id: params.clientId,
    clerk_id: params.clerkId,
    redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge,
    code_challenge_method: params.codeChallengeMethod,
    scope: params.scope,
    expires_at: expiresAt,
  });
  if (error) throw new Error(error.message);
  return code;
}

async function verifyPkce(codeChallenge: string, codeVerifier: string): Promise<boolean> {
  const encoded = new TextEncoder().encode(codeVerifier);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const base64url = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return base64url === codeChallenge;
}

export async function exchangeCode(params: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<string | null> {
  const supabase = adminClient();
  const { data: row } = await supabase
    .from("oauth_codes")
    .select("*")
    .eq("code", params.code)
    .eq("client_id", params.clientId)
    .maybeSingle();

  if (!row) return null;
  if (row.used) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  if (row.redirect_uri !== params.redirectUri) return null;
  if (!(await verifyPkce(row.code_challenge, params.codeVerifier))) return null;

  // Mark code as used (single-use)
  await supabase.from("oauth_codes").update({ used: true }).eq("code", params.code);

  // Issue access token
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const token = Array.from(tokenBytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const hash = await hashToken(token);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { error } = await supabase.from("oauth_tokens").insert({
    token_hash: hash,
    client_id: params.clientId,
    clerk_id: row.clerk_id,
    scope: row.scope,
    expires_at: expiresAt,
  });
  if (error) throw new Error(error.message);
  return token;
}

/** Resolve an OAuth bearer token to a clerk_id. Returns null if invalid/expired. */
export async function clerkIdFromOAuthToken(req: Request): Promise<string | null> {
  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const hash = await hashToken(token);
  const { data } = await adminClient()
    .from("oauth_tokens")
    .select("clerk_id, expires_at")
    .eq("token_hash", hash)
    .maybeSingle();
  if (!data) return null;
  if (new Date(data.expires_at) < new Date()) return null;
  return data.clerk_id;
}
