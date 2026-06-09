"use client";
import type { UserStorageAggregate } from "./page";

interface Totals {
  user_count: number;
  total_docs: number;
  total_bytes: number;
}

interface Props {
  aggregates: UserStorageAggregate[];
  totals: Totals;
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
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

export function AdminStorageView({ aggregates, totals }: Props) {
  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "40px 24px", fontFamily: "var(--font-sans)", color: "var(--fg)" }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 4 }}>Storage</h1>
      <p style={{ color: "var(--muted)", fontSize: 13, marginBottom: 32 }}>
        Text storage per user — 5 GB limit (all tiers).
      </p>

      <div style={{ display: "flex", gap: 24, marginBottom: 40 }}>
        {[
          { label: "Users", value: totals.user_count },
          { label: "Total docs", value: totals.total_docs.toLocaleString() },
          { label: "Total stored", value: fmtBytes(totals.total_bytes) },
        ].map(({ label, value }) => (
          <div key={label} style={{ background: "var(--surface)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius)", padding: "16px 20px", minWidth: 130 }}>
            <div style={{ fontSize: 22, fontWeight: 600 }}>{value}</div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>{label}</div>
          </div>
        ))}
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border-subtle)", color: "var(--muted)" }}>
            <th style={{ textAlign: "left", padding: "8px 12px 8px 0", fontWeight: 500 }}>User</th>
            <th style={{ textAlign: "right", padding: "8px 12px", fontWeight: 500 }}>Docs</th>
            <th style={{ textAlign: "left", padding: "8px 0 8px 12px", fontWeight: 500, minWidth: 200 }}>Storage used</th>
            <th style={{ textAlign: "right", padding: "8px 0", fontWeight: 500 }}>Last write</th>
          </tr>
        </thead>
        <tbody>
          {aggregates.map((a) => (
            <tr key={a.namespace} style={{ borderBottom: "1px solid var(--border-subtle)" }}>
              <td style={{ padding: "10px 12px 10px 0" }}>
                <div style={{ fontWeight: 500 }}>{a.handle}</div>
                {a.email && <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 1 }}>{a.email}</div>}
              </td>
              <td style={{ textAlign: "right", padding: "10px 12px", color: "var(--muted)" }}>
                {a.doc_count.toLocaleString()}
              </td>
              <td style={{ padding: "10px 0 10px 12px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ flex: 1, height: 6, background: "var(--border-subtle)", borderRadius: 3, overflow: "hidden" }}>
                    <div style={{
                      height: "100%",
                      width: `${Math.min(100, a.text_pct * 100).toFixed(2)}%`,
                      background: a.text_pct > 0.9 ? "var(--error, #e05)" : a.text_pct > 0.7 ? "#f59e0b" : "var(--accent)",
                      borderRadius: 3,
                      minWidth: a.bytes_used > 0 ? 3 : 0,
                    }} />
                  </div>
                  <span style={{ whiteSpace: "nowrap", minWidth: 90, color: "var(--muted)" }}>
                    {fmtBytes(a.bytes_used)} / 5 GB
                  </span>
                </div>
              </td>
              <td style={{ textAlign: "right", padding: "10px 0", color: "var(--muted)", whiteSpace: "nowrap" }}>
                {fmtRelative(a.last_write)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
