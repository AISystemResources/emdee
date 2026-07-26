import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";

// SPRINT-150: Cerebral brand rebrand.
// - Positioning: "Your Second Brain — for you and your AI."
// - Palette: Cerebral Pink (#FF3D6E) + Oxblood (#8B0033) + warm off-white paper.
// - Typography: Fraunces (display, italic sings in the hero) + Inter (body)
//   + JetBrains Mono (code + labels).
// - Structural motif: anatomical brain-lobe eyebrows (FRONTAL / OCCIPITAL /
//   TEMPORAL / PARIETAL / CEREBELLUM) tie every section back to the
//   "Second Brain" story without cartoon literalism.

const CANONICAL = "https://emdee.tech";

export const metadata: Metadata = {
  metadataBase: new URL(CANONICAL),
  title: "EMDEE — Your Second Brain, for you and your AI",
  description:
    "EMDEE is a local-first Second Brain in plain markdown files. Built-in MCP server lets Claude, ChatGPT, and other AI agents extend your thinking safely — with version guards, atomic multi-doc writes, and full undo.",
  keywords: [
    "second brain",
    "personal knowledge management",
    "AI knowledge base",
    "MCP server",
    "Claude MCP",
    "markdown notes",
    "local-first notes",
    "Obsidian alternative",
    "Notion alternative",
    "AI-native notes",
  ],
  alternates: { canonical: CANONICAL },
  openGraph: {
    title: "EMDEE — Your Second Brain, for you and your AI",
    description:
      "Local-first markdown Second Brain that Claude, ChatGPT, and other AI agents can safely extend via MCP.",
    type: "website",
    url: CANONICAL,
    siteName: "EMDEE",
  },
  twitter: {
    card: "summary_large_image",
    title: "EMDEE — Your Second Brain, for you and your AI",
    description:
      "Local-first markdown Second Brain that Claude, ChatGPT, and other AI agents can safely extend via MCP.",
  },
  robots: { index: true, follow: true },
};

function jsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "EMDEE",
    description:
      "Local-first Second Brain in plain markdown with built-in MCP server for AI agents.",
    applicationCategory: "ProductivityApplication",
    operatingSystem: "macOS, Windows, Linux, Web",
    offers: [{ "@type": "Offer", name: "Free (local + npm)", price: "0", priceCurrency: "USD" }],
    softwareVersion: "0.4.x",
    downloadUrl: "https://www.npmjs.com/package/@aisystemresources/emdee",
    url: CANONICAL,
    author: { "@type": "Organization", name: "AI System Resources" },
  };
}

export default async function Home() {
  const { userId } = await auth();
  const isSignedIn = Boolean(userId);

  return (
    <main className="cerebral-page">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd()) }} />

      <nav className="cerebral-nav">
        <div className="cerebral-nav-inner">
          <Link href="/" className="cerebral-brand">EMDEE</Link>
          <div className="cerebral-nav-right">
            <Link href="/vault" className="cerebral-nav-link">Public vault</Link>
            <a href="https://github.com/AISystemResources/emdee" className="cerebral-nav-link" target="_blank" rel="noopener">GitHub</a>
            {isSignedIn ? (
              <Link href={`/vault/${userId}`} className="cerebral-cta-primary cerebral-cta-nav">Vault →</Link>
            ) : (
              <Link href="/sign-in" className="cerebral-cta-primary cerebral-cta-nav">Sign in</Link>
            )}
          </div>
        </div>
      </nav>

      {/* FRONTAL — the higher-order thinking. Hero. */}
      <section className="cerebral-section cerebral-hero">
        <span className="cerebral-lobe">Frontal Lobe</span>
        <h1 className="cerebral-h1">
          Your <em>Second Brain</em>,<br />
          for you and your AI.
        </h1>
        <p className="cerebral-lede">
          EMDEE keeps your notes in plain markdown, and lets Claude, ChatGPT, and other AI agents
          extend your thinking safely. Version-guarded writes. Multi-agent aware. Yours forever.
        </p>
        <div className="cerebral-cta-row">
          <Link href="/sign-in" className="cerebral-cta-primary">Start your Second Brain (free)</Link>
          <a
            href="https://www.npmjs.com/package/@aisystemresources/emdee"
            className="cerebral-cta-code"
            target="_blank"
            rel="noopener"
          >
            <span className="cerebral-code-prefix">$</span> npm i @aisystemresources/emdee
          </a>
        </div>
        <p className="cerebral-microcopy">Free forever for local use · Cloud sync + team sharing coming soon</p>
      </section>

      {/* OCCIPITAL — the visual cortex. What is EMDEE? */}
      <section className="cerebral-section">
        <span className="cerebral-lobe">Occipital Lobe</span>
        <h2 className="cerebral-h2">What is a Second Brain, and why does it need to be AI-safe?</h2>
        <div className="cerebral-prose">
          <p>
            A Second Brain is where you offload the thoughts, ideas, references, and
            half-formed plans your first brain can&apos;t hold all at once. Every knowledge worker
            builds one — in Notion, Obsidian, Apple Notes, a folder of text files.
          </p>
          <p>
            When AI agents entered the loop, that Second Brain became load-bearing in a new way:
            you want Claude to know what you&apos;ve been working on, ChatGPT to remember the
            context from three weeks ago, Cursor to reference your architecture notes without
            you re-pasting them every session.
          </p>
          <p>
            EMDEE is a Second Brain built for that reality. Your knowledge lives as plain
            markdown files in a folder you own — no proprietary format, no lock-in. A built-in
            <em> MCP server </em>
            exposes every read and write to your AI agents. The write path is
            <em> safe by construction</em>: every mutation is version-guarded, multi-doc
            operations are atomic, and the graph structure (parent / child / associated) is
            enforced by the tools themselves so an agent can&apos;t silently corrupt what you&apos;ve built.
          </p>
        </div>
      </section>

      {/* TEMPORAL — memory + language. Comparison. */}
      <section className="cerebral-section">
        <span className="cerebral-lobe">Temporal Lobe</span>
        <h2 className="cerebral-h2">How EMDEE compares</h2>
        <div className="cerebral-table-wrap">
          <table className="cerebral-table">
            <thead>
              <tr>
                <th></th>
                <th className="cerebral-th-self">EMDEE</th>
                <th>Obsidian</th>
                <th>Notion</th>
                <th>Logseq</th>
              </tr>
            </thead>
            <tbody>
              <Row label="Plain markdown files" cells={["yes", "yes", "no", "yes"]} />
              <Row label="Built-in MCP server for AI" cells={["yes", "no", "no", "no"]} />
              <Row label="Multi-agent safe writes (OCC)" cells={["yes", "—", "—", "—"]} />
              <Row label="Local-first (offline)" cells={["yes", "yes", "no", "yes"]} />
              <Row label="Web renderer + graph view" cells={["yes", "yes", "partial", "yes"]} />
              <Row label="Free tier" cells={["local + npm free", "full app free", "limited", "full app free"]} />
              <Row label="Open source" cells={["planned", "no", "no", "yes"]} />
            </tbody>
          </table>
        </div>
      </section>

      {/* PARIETAL — spatial / structural. Features. */}
      <section className="cerebral-section">
        <span className="cerebral-lobe">Parietal Lobe</span>
        <h2 className="cerebral-h2">Built for AI-native knowledge work</h2>
        <div className="cerebral-grid">
          <FeatureCard title="MCP-native" body="Every read and write tool is exposed to Claude, ChatGPT, and other agents via the Model Context Protocol. Your AI adds nodes, patches sections, moves docs, and derives the graph — safely." />
          <FeatureCard title="Multi-agent safe" body="Universal version-guards prevent two agents from silently overwriting each other. Stale writes are rejected with an actionable conflict response." />
          <FeatureCard title="Local-first" body="Your Second Brain lives on your disk as plain markdown. SQLite backs the graph index locally. Cloud sync is optional and opt-in." />
          <FeatureCard title="Enforced structure" body="Reciprocal edges (Parent of / Child of / Associated with) are validated by the tools, not left to prose. Lint catches drift; reconcile heals it." />
          <FeatureCard title="Portable by design" body="No proprietary format, no vendor lock-in. Export as a zip of .md files any time. Move to Obsidian tomorrow if you outgrow us." />
          <FeatureCard title="Shared vaults" body="Grant read or write access to subtrees. Human collaborators and their AI agents navigate shared docs without leaking outside the share root." />
        </div>
      </section>

      {/* Install paths — where the visitor commits. */}
      <section className="cerebral-section">
        <span className="cerebral-lobe">Motor Cortex</span>
        <h2 className="cerebral-h2">Three ways to start</h2>
        <div className="cerebral-grid">
          <InstallCard heading="Cloud (fastest)" body="Sign in with Google. Hosted Second Brain instantly. Your agents connect via MCP HTTP. Free tier includes local + limited cloud." cta="Sign in" href="/sign-in" />
          <InstallCard
            heading="npm CLI (local)"
            body="Install the emdee CLI. Full MCP server on your machine. Runs entirely offline. Free forever."
            cta="npm install"
            href="https://www.npmjs.com/package/@aisystemresources/emdee"
            code="npm i -g @aisystemresources/emdee"
          />
          <InstallCard heading="Desktop app" body="Native macOS / Windows / Linux app with graph view, editor, and offline sync. Coming soon." cta="Notify me" href="/sign-in" disabled />
        </div>
      </section>

      {/* CEREBELLUM — coordination + habit. FAQ (GEO-friendly). */}
      <section className="cerebral-section">
        <span className="cerebral-lobe">Cerebellum</span>
        <h2 className="cerebral-h2">Common questions</h2>
        <div>
          <FaqItem
            q="How is EMDEE different from Obsidian?"
            a="Obsidian is a markdown editor with a plugin ecosystem — optimised for humans typing. EMDEE is a markdown editor plus a built-in MCP server, atomic multi-doc write tools, and version-guarded writes designed for AI agents to use safely. If you use Obsidian purely as a human notes app, stay on Obsidian. If you want an AI agent to reliably extend your Second Brain, use EMDEE."
          />
          <FaqItem
            q="Do I need to sign up to use EMDEE?"
            a="No. The npm CLI runs fully offline with no account. Sign-in only unlocks the cloud vault, sync, and sharing. Local users are first-class citizens."
          />
          <FaqItem
            q="Can I use EMDEE with Claude?"
            a="Yes — that's the primary integration. Point Claude Desktop or Claude Code at the EMDEE MCP server (either your local npm install or the cloud HTTP endpoint) and Claude can read, write, and navigate your Second Brain."
          />
          <FaqItem
            q="Can I use EMDEE with ChatGPT / Cursor / other agents?"
            a="Any AI client that speaks the Model Context Protocol can use EMDEE. Cursor, Continue.dev, and other MCP-compatible tools work out of the box."
          />
          <FaqItem
            q="Is my data safe?"
            a="Local mode: your data never leaves your disk. Cloud mode: your vault is stored in a per-user namespace on Supabase; only you (and anyone you explicitly share with) can read it. Export the entire Second Brain as a zip of markdown files at any time."
          />
          <FaqItem
            q="What does the free tier include?"
            a="The full local experience is free forever — npm install, full MCP server, graph rendering, all writing tools. Cloud sync, team sharing, and unlimited cloud storage will be part of a future paid tier."
          />
          <FaqItem
            q="Is EMDEE open source?"
            a="Open-sourcing the primitives is on the roadmap. The npm package and CLI are already public. See the GitHub for the current source."
          />
        </div>
      </section>

      <footer className="cerebral-footer">
        <p>
          EMDEE — your Second Brain, for you and your AI ·{" "}
          <a href="https://github.com/AISystemResources/emdee" target="_blank" rel="noopener">GitHub</a> ·{" "}
          <Link href="/vault">Public vault</Link> ·{" "}
          {isSignedIn ? (
            <Link href={`/vault/${userId}`}>Vault</Link>
          ) : (
            <Link href="/sign-in">Sign in</Link>
          )}
        </p>
      </footer>
    </main>
  );
}

function Row({ label, cells }: { label: string; cells: string[] }) {
  return (
    <tr>
      <td className="cerebral-td-label">{label}</td>
      {cells.map((c, i) => {
        const isSelf = i === 0;
        const cls = c === "yes" ? "cerebral-td-yes" : c === "no" ? "cerebral-td-no" : "cerebral-td-neutral";
        return (
          <td key={i} className={`${cls} ${isSelf ? "cerebral-td-self" : ""}`}>
            {c === "yes" ? "✓" : c === "no" ? "✗" : c}
          </td>
        );
      })}
    </tr>
  );
}

function FeatureCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="cerebral-card">
      <h3 className="cerebral-h3">{title}</h3>
      <p>{body}</p>
    </div>
  );
}

function InstallCard({
  heading, body, cta, href, code, disabled,
}: { heading: string; body: string; cta: string; href: string; code?: string; disabled?: boolean }) {
  return (
    <div className="cerebral-card">
      <h3 className="cerebral-h3">{heading}</h3>
      <p>{body}</p>
      {code ? <div className="cerebral-inline-code">{code}</div> : null}
      <div style={{ marginTop: "1.25rem" }}>
        {disabled ? (
          <span className="cerebral-cta-primary" style={{ opacity: 0.4, cursor: "default" }}>{cta}</span>
        ) : (
          <a href={href} className="cerebral-cta-primary" target={href.startsWith("http") ? "_blank" : undefined} rel="noopener">
            {cta}
          </a>
        )}
      </div>
    </div>
  );
}

function FaqItem({ q, a }: { q: string; a: string }) {
  return (
    <details className="cerebral-faq">
      <summary>{q}</summary>
      <p>{a}</p>
    </details>
  );
}
