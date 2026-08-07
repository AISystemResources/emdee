import { auth } from "@clerk/nextjs/server";
import { notFound } from "next/navigation";
import Link from "next/link";
import { adminClient } from "@/src/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// SPRINT-188: admin vault viewer — index page.
//
// Lists every user with vault activity + basic health signals (doc
// count, orphan count) so admins can spot problem vaults quickly and
// click through to read-only view. Read-only per the user's directive:
// "the MCP and CLI should not have any tools to touch other people's
// vault, even if it's admin." Reads only; writes remain self-only at
// the API layer.

interface Row {
  namespace: string;
  handle: string | null;
  email: string | null;
  doc_count: number;
  orphan_count: number;
  bytes_used: number;
  last_write: string | null;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fmtRelative(iso: string | null): string {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export default async function AdminVaultIndex() {
  const { userId } = await auth();
  if (!userId) notFound();
  const admin = adminClient();
  const { data: me } = await admin
    .from("profiles")
    .select("is_admin")
    .eq("clerk_id", userId)
    .maybeSingle();
  if (!me?.is_admin) notFound();

  // Pull storage view (doc counts + bytes per namespace) + health rows
  // + profile lookups in parallel. Storage view is the primary index —
  // any namespace with docs shows up.
  const [{ data: storageRows }, { data: healthRows }, { data: profileRows }] = await Promise.all([
    admin.from("vault_storage_by_namespace").select("namespace, doc_count, bytes_used"),
    admin.from("namespace_health").select("namespace, orphan_count, last_scan_at"),
    admin.from("profiles").select("clerk_id, handle, email"),
  ]);

  const healthByNs = new Map((healthRows ?? []).map((r) => [r.namespace as string, r]));
  const profileByNs = new Map((profileRows ?? []).map((p) => [p.clerk_id as string, p]));

  const rows: Row[] = (storageRows ?? [])
    .filter((r: { namespace: string }) => !!r.namespace && r.namespace !== "public")
    .map((r: { namespace: string; doc_count: number; bytes_used: number }) => {
      const health = healthByNs.get(r.namespace);
      const profile = profileByNs.get(r.namespace);
      return {
        namespace: r.namespace,
        handle: (profile?.handle as string | null) ?? null,
        email: (profile?.email as string | null) ?? null,
        doc_count: r.doc_count ?? 0,
        orphan_count: (health?.orphan_count as number | null) ?? 0,
        bytes_used: r.bytes_used ?? 0,
        last_write: (health?.last_scan_at as string | null) ?? null,
      };
    })
    .sort((a: Row, b: Row) => b.doc_count - a.doc_count);

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto", padding: "40px 24px", fontFamily: "var(--font-sans)", color: "var(--fg)" }}>
      <div style={{ marginBottom: 24 }}>
        <Link href="/admin" style={{ fontSize: 12, color: "var(--muted)", textDecoration: "none" }}>← Admin</Link>
      </div>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 4 }}>User Vaults</h1>
      <p style={{ color: "var(--muted)", fontSize: 13, marginBottom: 24 }}>
        Read-only view of every user vault. Click a row to open the vault as they see it. Writes are refused at the API layer even for admins — repairs happen via Supabase MCP.
      </p>

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border-subtle)", color: "var(--muted)" }}>
            <th style={{ textAlign: "left", padding: "8px 12px 8px 0", fontWeight: 500 }}>Handle</th>
            <th style={{ textAlign: "left", padding: "8px 12px", fontWeight: 500 }}>Email</th>
            <th style={{ textAlign: "right", padding: "8px 12px", fontWeight: 500 }}>Docs</th>
            <th style={{ textAlign: "right", padding: "8px 12px", fontWeight: 500 }}>Orphans</th>
            <th style={{ textAlign: "right", padding: "8px 12px", fontWeight: 500 }}>Storage</th>
            <th style={{ textAlign: "right", padding: "8px 0 8px 12px", fontWeight: 500 }}>Last scan</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.namespace} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
              <td style={{ padding: "8px 12px 8px 0" }}>
                <Link href={`/admin/vault/${r.namespace}`} style={{ color: "var(--accent)", textDecoration: "none", fontWeight: 500 }}>
                  {r.handle ?? "—"}
                </Link>
                <div style={{ fontSize: 10, color: "var(--muted)", fontFamily: "var(--font-mono)" }}>{r.namespace}</div>
              </td>
              <td style={{ padding: "8px 12px", color: "var(--muted)" }}>{r.email ?? "—"}</td>
              <td style={{ padding: "8px 12px", textAlign: "right" }}>{r.doc_count}</td>
              <td style={{ padding: "8px 12px", textAlign: "right", color: r.orphan_count > 0 ? "#B45309" : "var(--muted)" }}>{r.orphan_count > 0 ? `⚠ ${r.orphan_count}` : "0"}</td>
              <td style={{ padding: "8px 12px", textAlign: "right", color: "var(--muted)" }}>{fmtBytes(r.bytes_used)}</td>
              <td style={{ padding: "8px 0 8px 12px", textAlign: "right", color: "var(--muted)" }}>{fmtRelative(r.last_write)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
