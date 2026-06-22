import Link from "next/link";

export function LandingPage() {
  return (
    <div className="landing">
      <header className="landing-header">
        <span className="landing-wordmark">EMDEE</span>
      </header>
      <main className="landing-hero">
        <h1 className="landing-headline">
          Your personal knowledge graph,<br />
          connected to Claude.
        </h1>
        <p className="landing-sub">
          A local-first vault of plain-markdown notes — organised as a graph,
          readable by AI. Write in any editor; explore, link, and query with Claude.
        </p>
        <div className="landing-actions">
          <Link href="/sign-in" className="landing-cta-primary">
            Create your vault
          </Link>
          <Link href="/public" className="landing-cta-secondary">
            Browse a live vault →
          </Link>
        </div>
      </main>
    </div>
  );
}
