import Link from "next/link";

// SPRINT-052 (SIG-009): public landing CTA. Visible only on the public `/`
// route for unauthenticated visitors. Renders above the live shell as a
// thin banner with a "Sign in to start your own vault" link.
//
// Server component — no client hooks. The auth decision is made one level up
// in `app/page.tsx`, which only renders this when there's no userId.

export function PublicLandingCta() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0.5rem 1rem",
        background: "#0a0a0a",
        color: "#fff",
        borderBottom: "1px solid #2a2a2a",
        fontSize: "0.9rem",
        flexShrink: 0,
        gap: "0.75rem",
      }}
    >
      <span style={{ opacity: 0.85 }}>
        Welcome to EMDEE — your knowledge graph in markdown.
      </span>
      <Link
        href="/sign-in"
        style={{
          color: "#fff",
          background: "#0070f3",
          padding: "0.4rem 0.9rem",
          borderRadius: "4px",
          textDecoration: "none",
          fontWeight: 500,
          whiteSpace: "nowrap",
        }}
      >
        Sign in to start your own vault →
      </Link>
    </div>
  );
}
