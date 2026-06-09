import { auth } from "@clerk/nextjs/server";
import { notFound } from "next/navigation";
import { adminClient } from "@/src/lib/supabase/admin";
import { AdminStorageView } from "./AdminStorageView";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TEXT_LIMIT_BYTES = 5 * 1024 * 1024 * 1024;

interface StorageRow {
  namespace: string;
  doc_count: number;
  bytes_used: number;
  last_write: string | null;
}

interface ProfileRow {
  clerk_id: string;
  handle: string | null;
  email: string | null;
}

export interface UserStorageAggregate {
  namespace: string;
  handle: string;
  email: string | null;
  doc_count: number;
  bytes_used: number;
  text_limit_bytes: number;
  text_pct: number;
  last_write: string | null;
}

export default async function AdminStoragePage() {
  const { userId } = await auth();
  if (!userId) notFound();

  const admin = adminClient();

  const { data: me } = await admin
    .from("profiles")
    .select("clerk_id, is_admin")
    .eq("clerk_id", userId)
    .maybeSingle();
  if (!me?.is_admin) notFound();

  const { data: storageRows, error } = await admin
    .from("vault_storage_by_namespace")
    .select("namespace, doc_count, bytes_used, last_write")
    .order("bytes_used", { ascending: false });

  if (error) throw new Error(error.message);

  const rows = (storageRows ?? []) as StorageRow[];
  const namespaces = rows.map((r) => r.namespace).filter(Boolean);

  const { data: profiles } = namespaces.length
    ? await admin
        .from("profiles")
        .select("clerk_id, handle, email")
        .in("clerk_id", namespaces)
    : { data: [] };

  const profileById = new Map<string, ProfileRow>(
    ((profiles ?? []) as ProfileRow[]).map((p) => [p.clerk_id, p])
  );

  const aggregates: UserStorageAggregate[] = rows.map((r) => {
    const profile = profileById.get(r.namespace);
    return {
      namespace: r.namespace,
      handle: profile?.handle ?? r.namespace.slice(0, 12),
      email: profile?.email ?? null,
      doc_count: r.doc_count,
      bytes_used: r.bytes_used,
      text_limit_bytes: TEXT_LIMIT_BYTES,
      text_pct: r.bytes_used / TEXT_LIMIT_BYTES,
      last_write: r.last_write,
    };
  });

  const totals = {
    user_count: aggregates.length,
    total_docs: aggregates.reduce((s, a) => s + a.doc_count, 0),
    total_bytes: aggregates.reduce((s, a) => s + a.bytes_used, 0),
  };

  return (
    <div style={{ minHeight: "100dvh", background: "var(--bg)" }}>
      <AdminStorageView aggregates={aggregates} totals={totals} />
    </div>
  );
}
