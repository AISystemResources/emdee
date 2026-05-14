"use client";

import { useEffect, useState } from "react";

export const dynamic = "force-dynamic";

/**
 * Localhost-side callback for the cloud-link handshake. Reads
 * `cloud_user_id` from the URL, persists it, and tells the user they
 * can close the tab. The local app reads `localStorage.emdee_cloud_user_id`
 * when Push to Cloud fires.
 */
export default function CloudLinkCallback() {
  const [status, setStatus] = useState<"working" | "done" | "error">("working");
  const [cloudUserId, setCloudUserId] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("cloud_user_id");
    if (!id) {
      setStatus("error");
      return;
    }
    try {
      localStorage.setItem("emdee_cloud_user_id", id);
      setCloudUserId(id);
      setStatus("done");
    } catch {
      setStatus("error");
    }
  }, []);

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui, sans-serif", background: "#fafafa" }}>
      <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, padding: "40px 48px", maxWidth: 460, width: "calc(100% - 32px)", textAlign: "center" }}>
        <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-0.5px", marginBottom: 8 }}>EMDEE</div>
        <div style={{ width: 48, height: 1, background: "#e5e7eb", margin: "0 auto 24px" }} />
        {status === "working" && <p style={{ color: "#6b7280" }}>Linking cloud account…</p>}
        {status === "error" && (
          <>
            <h1 style={{ fontSize: 18, fontWeight: 600 }}>Link failed</h1>
            <p style={{ color: "#6b7280" }}>Missing <code>cloud_user_id</code> in the callback URL.</p>
          </>
        )}
        {status === "done" && (
          <>
            <h1 style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>Cloud account linked</h1>
            <p style={{ color: "#6b7280", marginBottom: 16, fontSize: 14 }}>
              Local dev will push to <code style={{ background: "#f3f4f6", padding: "2px 6px", borderRadius: 4 }}>{cloudUserId}</code>.
            </p>
            <p style={{ color: "#9ca3af", fontSize: 13 }}>You can close this tab.</p>
            <a href="/" style={{ display: "inline-block", marginTop: 20, padding: "8px 18px", borderRadius: 7, background: "#111", color: "#fff", textDecoration: "none", fontSize: 14 }}>Back to app</a>
          </>
        )}
      </div>
    </div>
  );
}
