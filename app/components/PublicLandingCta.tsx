import Link from "next/link";

// SPRINT-052 + SPRINT-150: public-vault banner CTA.
// Copy + accent color updated to match the Cerebral brand system —
// "Second Brain" replaces "knowledge graph", pink primary replaces the
// old blue #0070f3. Renders above the vault renderer for unauthenticated
// visitors on `/vault` only.

export function PublicLandingCta() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0.55rem 1rem",
        background: "#0a0a0a",
        color: "#fff",
        borderBottom: "1px solid #2a2a2a",
        fontSize: "0.9rem",
        flexShrink: 0,
        gap: "0.75rem",
      }}
    >
      <span style={{ opacity: 0.85 }}>
        Welcome to EMDEE — your Second Brain, for you and your AI.
      </span>
      <Link
        href="/sign-in"
        style={{
          color: "#fff",
          background: "var(--accent)",
          padding: "0.4rem 0.9rem",
          borderRadius: "4px",
          textDecoration: "none",
          fontWeight: 500,
          whiteSpace: "nowrap",
        }}
      >
        Sign in to start your Second Brain →
      </Link>
    </div>
  );
}
