import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<{ return?: string }>;
}

/**
 * Cloud-link handshake. Local dev sends users here so they can sign into
 * their cloud account, then we bounce them back to localhost with their
 * Clerk userId in the URL. The local callback stashes it so "Push to
 * Cloud" knows which namespace to target.
 *
 * Security: we only redirect to http://localhost:* / http://127.0.0.1:*.
 * Anything else is rejected so attackers can't trick this into exfiltrating
 * userIds to an arbitrary domain.
 */
export default async function CloudLinkPage({ searchParams }: Props) {
  const { return: returnUrl } = await searchParams;

  if (!returnUrl || !isAllowedReturn(returnUrl)) {
    return (
      <PageShell>
        <h1>Invalid request</h1>
        <p>Missing or unsupported <code>return</code> URL. Only localhost callbacks are allowed.</p>
      </PageShell>
    );
  }

  // Clerk middleware (proxy.ts) auto-protects this route — if we got here,
  // the user is signed in.
  const { userId } = await auth();
  if (!userId) {
    // Defensive: shouldn't happen because middleware protects the route.
    redirect(`/sign-in?redirect_url=${encodeURIComponent(`/cloud-link?return=${encodeURIComponent(returnUrl)}`)}`);
  }

  const dest = new URL(returnUrl);
  dest.searchParams.set("cloud_user_id", userId!);
  redirect(dest.toString());
}

function isAllowedReturn(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:") return false;
    return u.hostname === "localhost" || u.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui, sans-serif", background: "#fafafa" }}>
      <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "40px 48px", maxWidth: 420 }}>
        {children}
      </div>
    </div>
  );
}
