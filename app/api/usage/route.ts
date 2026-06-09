import { auth } from "@clerk/nextjs/server";
import { adminClient } from "@/src/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// 5 GB in bytes — text storage limit per user (all tiers, for now).
const TEXT_LIMIT_BYTES = 5 * 1024 * 1024 * 1024;

export async function GET() {
  const { userId } = await auth();
  if (!userId) return new Response("Unauthorized", { status: 401 });

  const { data, error } = await adminClient()
    .rpc("vault_storage_for_namespace", { p_namespace: userId })
    .single();

  if (error) return new Response("storage query failed", { status: 500 });

  const row = data as { doc_count: number; bytes_used: number; last_write: string | null } | null;
  const bytes_used = row?.bytes_used ?? 0;
  const doc_count = row?.doc_count ?? 0;
  const last_write = row?.last_write ?? null;

  return Response.json({
    text_bytes_used: bytes_used,
    text_limit_bytes: TEXT_LIMIT_BYTES,
    text_pct: bytes_used / TEXT_LIMIT_BYTES,
    doc_count,
    last_write,
  });
}
