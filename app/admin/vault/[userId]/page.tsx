import { auth } from "@clerk/nextjs/server";
import { notFound } from "next/navigation";
import Link from "next/link";
import { adminClient } from "@/src/lib/supabase/admin";
import { AppShell } from "@/app/components/AppShell";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// SPRINT-188: admin read-only viewer for a specific user's vault.
//
// Reuses AppShell with the target namespace. Writes are refused at the
// API layer (PUT /api/doc + every MCP tool remain strictly self-only)
// so any edit attempt fails silently on the wire. The banner across the
// top makes it obvious what you're looking at.
//
// Every visit logs an entry in mcp_activity via /api/index and
// /api/doc's admin-bypass path — audit trail so any user can ask
// "did you look at my vault?" and get an honest answer.

interface Props {
  params: Promise<{ userId: string }>;
}

export default async function AdminVaultView({ params }: Props) {
  const { userId: currentUserId } = await auth();
  if (!currentUserId) notFound();
  const { userId: targetUserId } = await params;

  const admin = adminClient();
  const { data: me } = await admin
    .from("profiles")
    .select("is_admin")
    .eq("clerk_id", currentUserId)
    .maybeSingle();
  if (!me?.is_admin) notFound();

  // Look up the target user's profile for the banner.
  const { data: target } = await admin
    .from("profiles")
    .select("handle, email")
    .eq("clerk_id", targetUserId)
    .maybeSingle();

  return (
    <div style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
      <div
        style={{
          background: "#B45309",
          color: "#FFFBEB",
          padding: "6px 16px",
          fontSize: 12,
          fontFamily: "var(--font-sans)",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <span style={{ fontWeight: 600, letterSpacing: 0.4, textTransform: "uppercase", fontSize: 11 }}>
          Admin view · read-only
        </span>
        <span>
          {target?.handle ?? "—"} · {target?.email ?? targetUserId}
        </span>
        <span style={{ flex: 1 }} />
        <Link href="/admin/vault" style={{ color: "#FFFBEB", textDecoration: "underline", fontSize: 12 }}>
          ← All vaults
        </Link>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <AppShell namespace={targetUserId} readOnly />
      </div>
    </div>
  );
}
