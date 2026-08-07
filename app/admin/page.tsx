import { auth } from "@clerk/nextjs/server";
import { notFound } from "next/navigation";
import { adminClient } from "@/src/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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

export default async function AdminPage() {
  const { userId } = await auth();
  if (!userId) notFound();

  const admin = adminClient();

  const { data: me } = await admin
    .from("profiles")
    .select("clerk_id, is_admin")
    .eq("clerk_id", userId)
    .maybeSingle();
  if (!me?.is_admin) notFound();

  const [
    { data: profiles },
    { data: storageRows },
    { data: pubRows },
  ] = await Promise.all([
    admin.from("profiles").select("clerk_id, handle, email, created_at").order("created_at", { ascending: false }).limit(10),
    admin.from("vault_storage_by_namespace").select("namespace, doc_count, bytes_used"),
    admin.from("publications").select("id"),
  ]);

  const users = profiles ?? [];
  const storage = storageRows ?? [];
  const totalDocs = storage.reduce((s: number, r: { doc_count: number }) => s + (r.doc_count ?? 0), 0);
  const totalBytes = storage.reduce((s: number, r: { bytes_used: number }) => s + (r.bytes_used ?? 0), 0);

  const stats = [
    { label: "Users", value: storage.length },
    { label: "Docs", value: totalDocs.toLocaleString() },
    { label: "Storage", value: fmtBytes(totalBytes) },
    { label: "Publications", value: (pubRows ?? []).length },
  ];

  const pages = [
    { href: "/admin/vault", label: "User Vaults", desc: "Read-only viewer for every user's vault (SPRINT-188)" },
    { href: "/admin/storage", label: "Storage", desc: "Doc counts and bytes per user" },
    { href: "/admin/publications", label: "Publications", desc: "Shared vaults and engagement events" },
  ];

  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: "40px 24px", fontFamily: "var(--font-sans)", color: "var(--fg)" }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 4 }}>Admin</h1>
      <p style={{ color: "var(--muted)", fontSize: 13, marginBottom: 32 }}>EMDEE system overview.</p>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 40 }}>
        {stats.map(({ label, value }) => (
          <div key={label} style={{ background: "var(--surface)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius)", padding: "16px 20px", minWidth: 110 }}>
            <div style={{ fontSize: 22, fontWeight: 600 }}>{value}</div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>{label}</div>
          </div>
        ))}
      </div>

      <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Pages</h2>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 40 }}>
        {pages.map(({ href, label, desc }) => (
          <a key={href} href={href} style={{ display: "block", background: "var(--surface)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius)", padding: "14px 18px", textDecoration: "none", color: "var(--fg)", minWidth: 180 }}>
            <div style={{ fontWeight: 500, fontSize: 14 }}>{label}</div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 3 }}>{desc}</div>
          </a>
        ))}
      </div>

      <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Recent sign-ups</h2>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border-subtle)", color: "var(--muted)" }}>
            <th style={{ textAlign: "left", padding: "8px 12px 8px 0", fontWeight: 500 }}>Handle</th>
            <th style={{ textAlign: "left", padding: "8px 12px", fontWeight: 500 }}>Email</th>
            <th style={{ textAlign: "right", padding: "8px 0 8px 12px", fontWeight: 500 }}>Joined</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u: { clerk_id: string; handle: string | null; email: string | null; created_at: string }) => (
            <tr key={u.clerk_id} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
              <td style={{ padding: "8px 12px 8px 0" }}>{u.handle ?? "—"}</td>
              <td style={{ padding: "8px 12px", color: "var(--muted)" }}>{u.email ?? "—"}</td>
              <td style={{ padding: "8px 0 8px 12px", textAlign: "right", color: "var(--muted)" }}>{fmtRelative(u.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
