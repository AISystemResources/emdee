import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getClient, storeAuthCode } from "@/src/lib/supabase/oauth";

export const dynamic = "force-dynamic";

interface Props {
  searchParams: Promise<Record<string, string>>;
}

export default async function AuthorizePage({ searchParams }: Props) {
  const params = await searchParams;
  const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, scope } = params;

  // Basic param validation
  if (response_type !== "code" || !client_id || !redirect_uri || !code_challenge) {
    return <ErrorPage message="Missing or invalid OAuth parameters." />;
  }
  if ((code_challenge_method ?? "S256") !== "S256") {
    return <ErrorPage message="Only S256 PKCE is supported." />;
  }

  // Validate client and redirect_uri
  const client = await getClient(client_id);
  if (!client) return <ErrorPage message="Unknown client_id." />;
  if (!client.redirect_uris.includes(redirect_uri)) {
    return <ErrorPage message="redirect_uri not registered for this client." />;
  }

  // Clerk auth gate
  const { userId } = await auth();
  if (!userId) {
    const here = `/oauth/authorize?${new URLSearchParams(params).toString()}`;
    redirect(`/sign-in?redirect_url=${encodeURIComponent(here)}`);
  }

  async function approve() {
    "use server";
    const p = await searchParams;
    const { client_id: cid, redirect_uri: ruri, code_challenge: cc, code_challenge_method: ccm, state: st, scope: sc } = p;
    const { userId: uid } = await auth();
    if (!uid) redirect("/sign-in");
    const code = await storeAuthCode({
      clientId: cid,
      clerkId: uid!,
      redirectUri: ruri,
      codeChallenge: cc,
      codeChallengeMethod: ccm ?? "S256",
      scope: sc ?? "mcp",
    });
    const dest = new URL(ruri);
    dest.searchParams.set("code", code);
    if (st) dest.searchParams.set("state", st);
    redirect(dest.toString());
  }

  async function deny() {
    "use server";
    const p = await searchParams;
    const dest = new URL(p.redirect_uri);
    dest.searchParams.set("error", "access_denied");
    if (p.state) dest.searchParams.set("state", p.state);
    redirect(dest.toString());
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#fafafa", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "40px 48px", maxWidth: 420, width: "100%", boxShadow: "0 2px 12px rgba(0,0,0,0.06)" }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.5px", marginBottom: 8 }}>EMDEE</div>
          <div style={{ width: 48, height: 1, background: "#e5e7eb", margin: "0 auto 24px" }} />
          <h1 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 8px", color: "#111" }}>Authorize access</h1>
          <p style={{ fontSize: 14, color: "#6b7280", margin: 0 }}>
            <strong style={{ color: "#111" }}>{client.client_name || client_id}</strong> is requesting access to your vault.
          </p>
        </div>

        <div style={{ background: "#f9fafb", border: "1px solid #f3f4f6", borderRadius: 8, padding: "16px 20px", marginBottom: 28 }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: "#374151", margin: "0 0 10px" }}>This will allow:</p>
          <ul style={{ margin: 0, padding: "0 0 0 18px", fontSize: 13, color: "#374151", lineHeight: 1.7 }}>
            <li>Read all docs in your vault</li>
            <li>Create and edit docs in your vault</li>
          </ul>
        </div>

        <div style={{ display: "flex", gap: 12 }}>
          <form action={deny} style={{ flex: 1 }}>
            <button type="submit" style={{ width: "100%", padding: "10px 0", borderRadius: 7, border: "1px solid #d1d5db", background: "#fff", color: "#374151", fontSize: 14, fontWeight: 500, cursor: "pointer" }}>
              Deny
            </button>
          </form>
          <form action={approve} style={{ flex: 1 }}>
            <button type="submit" style={{ width: "100%", padding: "10px 0", borderRadius: 7, border: "none", background: "#111", color: "#fff", fontSize: 14, fontWeight: 500, cursor: "pointer" }}>
              Authorize
            </button>
          </form>
        </div>

        <p style={{ fontSize: 11, color: "#9ca3af", textAlign: "center", marginTop: 20, marginBottom: 0 }}>
          Scope: {scope ?? "mcp"}
        </p>
      </div>
    </div>
  );
}

function ErrorPage({ message }: { message: string }) {
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#fafafa" }}>
      <div style={{ textAlign: "center", fontFamily: "system-ui, sans-serif" }}>
        <p style={{ color: "#ef4444", fontWeight: 600 }}>{message}</p>
      </div>
    </div>
  );
}
