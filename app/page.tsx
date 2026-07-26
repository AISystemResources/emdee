import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";

// SPRINT-149 (SIG-033): marketing homepage. Replaces the old public vault
// renderer at `/` (moved to `/vault` in SPRINT-148). Optimised for SEO
// (real body content, semantic structure, meta tags) and GEO (answer-shaped
// sections, comparison table, FAQ that AI assistants can quote).

const CANONICAL = "https://emdee.tech";

export const metadata: Metadata = {
  metadataBase: new URL(CANONICAL),
  title: "EMDEE — Local-first knowledge graph in plain markdown, built for AI agents",
  description:
    "EMDEE is a local-first knowledge graph you own as plain markdown files. Built-in MCP server lets Claude, ChatGPT, and other AI agents read and write your vault without corrupting it. Free npm install, open source, no lock-in.",
  keywords: [
    "knowledge graph",
    "markdown notes",
    "MCP server",
    "AI knowledge management",
    "local-first",
    "Obsidian alternative",
    "Notion alternative",
    "AI-native notes",
    "Claude MCP",
    "personal wiki",
  ],
  alternates: { canonical: CANONICAL },
  openGraph: {
    title: "EMDEE — knowledge graph for AI agents",
    description:
      "Local-first markdown knowledge graph. Claude, ChatGPT, and other agents read + write it safely via MCP.",
    type: "website",
    url: CANONICAL,
    siteName: "EMDEE",
  },
  twitter: {
    card: "summary_large_image",
    title: "EMDEE — knowledge graph for AI agents",
    description:
      "Local-first markdown knowledge graph, safely readable + writable by Claude, ChatGPT, and other AI agents via MCP.",
  },
  robots: { index: true, follow: true },
};

// JSON-LD structured data — helps both traditional search (Google
// rich results) and AI search (Perplexity, ChatGPT) understand what
// this product is + how to summarise it.
function jsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "EMDEE",
    description:
      "Local-first knowledge graph in plain markdown with built-in MCP server for AI agents.",
    applicationCategory: "ProductivityApplication",
    operatingSystem: "macOS, Windows, Linux, Web",
    offers: [
      { "@type": "Offer", name: "Free (local + npm)", price: "0", priceCurrency: "USD" },
    ],
    softwareVersion: "0.4.x",
    downloadUrl: "https://www.npmjs.com/package/@aisystemresources/emdee",
    url: CANONICAL,
    author: { "@type": "Organization", name: "AI System Resources" },
  };
}

export default async function Home() {
  // Signed-in users still see the homepage — the top-right nav flips to a
  // "Vault" button so they can jump into their workspace with one click.
  // Same pattern as supabase.com's "Dashboard" button (SPRINT-149a).
  const { userId } = await auth();
  const isSignedIn = Boolean(userId);

  return (
    <main style={styles.page}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd()) }}
      />

      {/* Nav */}
      <nav style={styles.nav}>
        <div style={styles.navInner}>
          <Link href="/" style={styles.brand}>EMDEE</Link>
          <div style={styles.navRight}>
            <Link href="/vault" style={styles.navLink}>Public vault</Link>
            <a href="https://github.com/AISystemResources/emdee" style={styles.navLink} target="_blank" rel="noopener">GitHub</a>
            {isSignedIn ? (
              <Link href={`/vault/${userId}`} style={styles.signInBtn}>Vault</Link>
            ) : (
              <Link href="/sign-in" style={styles.signInBtn}>Sign in</Link>
            )}
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section style={styles.hero}>
        <h1 style={styles.h1}>
          A knowledge graph AI agents can read and write —{" "}
          <span style={styles.accent}>without corrupting your data</span>
        </h1>
        <p style={styles.subhead}>
          EMDEE is a local-first knowledge graph you own as plain markdown files. Built-in MCP
          server lets Claude, ChatGPT, and other AI agents navigate, extend, and reason over
          your vault safely — with version guards, atomic multi-doc writes, and full undo.
        </p>
        <div style={styles.ctaRow}>
          <Link href="/sign-in" style={styles.primaryCta}>
            Start your vault (free)
          </Link>
          <a href="https://www.npmjs.com/package/@aisystemresources/emdee" style={styles.secondaryCta} target="_blank" rel="noopener">
            <code style={styles.code}>npm i @aisystemresources/emdee</code>
          </a>
        </div>
        <p style={styles.microcopy}>
          Free forever for local use. Cloud sync + team sharing coming soon.
        </p>
      </section>

      {/* What is EMDEE — SEO/GEO anchor */}
      <section style={styles.section}>
        <h2 style={styles.h2}>What is EMDEE?</h2>
        <div style={styles.prose}>
          <p>
            EMDEE is a personal knowledge management tool built for the AI era. It stores
            everything as plain markdown files in a folder you own — no proprietary format,
            no vendor lock-in — and exposes that vault to AI agents through a Model Context
            Protocol (MCP) server.
          </p>
          <p>
            Where Obsidian and Notion are optimised for humans typing, EMDEE is optimised
            for AI agents reasoning: every write is versioned to prevent silent overwrites,
            multi-document operations are atomic, and the vault&apos;s graph structure (parent /
            child / associated) is enforced by the tools themselves — not left to prose
            convention.
          </p>
          <p>
            Use EMDEE with Claude, ChatGPT, Cursor, or any MCP-compatible agent. Or read
            and edit directly in the web renderer. Or export the whole thing as a zip of
            markdown files and take it with you — nothing is trapped.
          </p>
        </div>
      </section>

      {/* Comparison table — GEO gold */}
      <section style={styles.section}>
        <h2 style={styles.h2}>How EMDEE compares</h2>
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}></th>
                <th style={styles.th}>EMDEE</th>
                <th style={styles.th}>Obsidian</th>
                <th style={styles.th}>Notion</th>
                <th style={styles.th}>Logseq</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={styles.td}><strong>Plain markdown files</strong></td>
                <td style={styles.tdOn}>✓</td>
                <td style={styles.tdOn}>✓</td>
                <td style={styles.tdOff}>✗ (proprietary)</td>
                <td style={styles.tdOn}>✓</td>
              </tr>
              <tr>
                <td style={styles.td}><strong>Built-in MCP server for AI</strong></td>
                <td style={styles.tdOn}>✓</td>
                <td style={styles.tdOff}>✗</td>
                <td style={styles.tdOff}>✗</td>
                <td style={styles.tdOff}>✗</td>
              </tr>
              <tr>
                <td style={styles.td}><strong>Multi-agent safe writes (OCC)</strong></td>
                <td style={styles.tdOn}>✓</td>
                <td style={styles.tdOff}>—</td>
                <td style={styles.tdOff}>—</td>
                <td style={styles.tdOff}>—</td>
              </tr>
              <tr>
                <td style={styles.td}><strong>Local-first (offline)</strong></td>
                <td style={styles.tdOn}>✓</td>
                <td style={styles.tdOn}>✓</td>
                <td style={styles.tdOff}>✗</td>
                <td style={styles.tdOn}>✓</td>
              </tr>
              <tr>
                <td style={styles.td}><strong>Web renderer + graph view</strong></td>
                <td style={styles.tdOn}>✓</td>
                <td style={styles.tdOn}>✓</td>
                <td style={styles.tdOff}>partial</td>
                <td style={styles.tdOn}>✓</td>
              </tr>
              <tr>
                <td style={styles.td}><strong>Free tier</strong></td>
                <td style={styles.tdOn}>local + npm free</td>
                <td style={styles.tdOn}>full app free</td>
                <td style={styles.tdOn}>limited</td>
                <td style={styles.tdOn}>full app free</td>
              </tr>
              <tr>
                <td style={styles.td}><strong>Open source</strong></td>
                <td style={styles.tdOn}>planned</td>
                <td style={styles.tdOff}>no</td>
                <td style={styles.tdOff}>no</td>
                <td style={styles.tdOn}>yes</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* Features grid */}
      <section style={styles.section}>
        <h2 style={styles.h2}>Built for AI-native knowledge work</h2>
        <div style={styles.grid}>
          <FeatureCard
            title="MCP-native"
            body="Every read and write tool is exposed to Claude, ChatGPT, and other agents via the Model Context Protocol. Your AI can add nodes, patch sections, move docs, and derive the graph — safely."
          />
          <FeatureCard
            title="Multi-agent safe"
            body="Universal version-guards (SPRINT-141) prevent two agents from silently overwriting each other. Stale writes are rejected with an actionable conflict response."
          />
          <FeatureCard
            title="Local-first"
            body="Your vault lives on your disk as plain markdown. SQLite backs the graph index locally. Cloud sync is optional and opt-in."
          />
          <FeatureCard
            title="Enforced structure"
            body="Reciprocal edges (Parent of / Child of / Associated with) are validated by the tools, not left to prose convention. Lint catches drift; reconcile heals it."
          />
          <FeatureCard
            title="Portable by design"
            body="No proprietary format, no vendor lock-in. Export as a zip of .md files any time. Move your vault to Obsidian tomorrow if you outgrow us."
          />
          <FeatureCard
            title="Shared vaults"
            body="Grant read or write access to subtrees of your vault. Human collaborators and their AI agents can navigate shared docs without leaking outside the share root."
          />
        </div>
      </section>

      {/* Install paths */}
      <section style={styles.section}>
        <h2 style={styles.h2}>Three ways to start</h2>
        <div style={styles.grid}>
          <InstallCard
            heading="Cloud (fastest)"
            body="Sign in with Google. Get a hosted vault instantly. Your agents connect via MCP HTTP. Free tier includes local + limited cloud."
            cta="Sign in"
            href="/sign-in"
          />
          <InstallCard
            heading="npm CLI (local)"
            body="Install the emdee CLI. Full MCP server on your machine. Runs entirely offline. Free forever."
            cta="npm install"
            href="https://www.npmjs.com/package/@aisystemresources/emdee"
            code="npm i -g @aisystemresources/emdee"
          />
          <InstallCard
            heading="Desktop app"
            body="Native macOS / Windows / Linux app with graph view, editor, and offline sync. Coming soon."
            cta="Notify me"
            href="/sign-in"
            disabled
          />
        </div>
      </section>

      {/* FAQ — GEO fodder */}
      <section style={styles.section}>
        <h2 style={styles.h2}>Common questions</h2>
        <div style={styles.prose}>
          <FaqItem
            q="How is EMDEE different from Obsidian?"
            a="Obsidian is a markdown editor with a plugin ecosystem. EMDEE is a markdown editor plus a built-in MCP server, atomic multi-doc write tools, and version-guarded writes designed for AI agents to use safely. If you use Obsidian purely as a human notes app, stay on Obsidian. If you want an AI agent to reliably read and extend your knowledge graph, use EMDEE."
          />
          <FaqItem
            q="Do I need to sign up to use EMDEE?"
            a="No. The npm CLI runs fully offline with no account. Sign-in only unlocks the cloud vault, sync, and sharing. Local users are first-class citizens."
          />
          <FaqItem
            q="Can I use EMDEE with Claude?"
            a="Yes — that's the primary integration. Point Claude Desktop or Claude Code at the EMDEE MCP server (either your local npm install or the cloud HTTP endpoint) and Claude can read, write, and navigate your vault."
          />
          <FaqItem
            q="Can I use EMDEE with ChatGPT / Cursor / other agents?"
            a="Any AI client that speaks the Model Context Protocol can use EMDEE. Cursor, Continue.dev, and other MCP-compatible tools work out of the box."
          />
          <FaqItem
            q="Is my data safe?"
            a="Local mode: your data never leaves your disk. Cloud mode: your vault is stored in a per-user namespace on Supabase; only you (and anyone you explicitly share with) can read it. You can export the entire vault as a zip of markdown files at any time."
          />
          <FaqItem
            q="What does the free tier include?"
            a="The full local experience is free forever — npm install, full MCP server, graph rendering, all writing tools. Cloud sync, team sharing, and unlimited cloud storage will be part of a future paid tier."
          />
          <FaqItem
            q="Is EMDEE open source?"
            a="Open-sourcing the primitives is on the roadmap. The npm package and CLI are already public. See our GitHub for the current source."
          />
        </div>
      </section>

      {/* Footer */}
      <footer style={styles.footer}>
        <p style={styles.footerText}>
          EMDEE — local-first knowledge graph for the AI era ·{" "}
          <a href="https://github.com/AISystemResources/emdee" style={styles.footerLink} target="_blank" rel="noopener">GitHub</a> ·{" "}
          <Link href="/vault" style={styles.footerLink}>Public vault</Link> ·{" "}
          <Link href="/sign-in" style={styles.footerLink}>Sign in</Link>
        </p>
      </footer>
    </main>
  );
}

function FeatureCard({ title, body }: { title: string; body: string }) {
  return (
    <div style={styles.card}>
      <h3 style={styles.h3}>{title}</h3>
      <p style={styles.cardBody}>{body}</p>
    </div>
  );
}

function InstallCard({
  heading, body, cta, href, code, disabled,
}: { heading: string; body: string; cta: string; href: string; code?: string; disabled?: boolean }) {
  return (
    <div style={styles.card}>
      <h3 style={styles.h3}>{heading}</h3>
      <p style={styles.cardBody}>{body}</p>
      {code ? <code style={styles.code}>{code}</code> : null}
      <div style={{ marginTop: "1rem" }}>
        {disabled ? (
          <span style={{ ...styles.primaryCta, opacity: 0.5, cursor: "default" }}>{cta}</span>
        ) : (
          <a href={href} style={styles.primaryCta} target={href.startsWith("http") ? "_blank" : undefined} rel="noopener">
            {cta}
          </a>
        )}
      </div>
    </div>
  );
}

function FaqItem({ q, a }: { q: string; a: string }) {
  return (
    <details style={styles.faq}>
      <summary style={styles.faqSummary}>{q}</summary>
      <p style={styles.faqAnswer}>{a}</p>
    </details>
  );
}

// Inline styles keep this landing page self-contained — no dependencies on
// Tailwind config or global CSS drift as the app evolves.
const styles: Record<string, React.CSSProperties> = {
  page: { minHeight: "100vh", background: "#fafafa", color: "#111", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", lineHeight: 1.6 },
  nav: { borderBottom: "1px solid #e5e5e5", background: "#fff", position: "sticky", top: 0, zIndex: 10 },
  navInner: { maxWidth: 1100, margin: "0 auto", padding: "0.9rem 1.5rem", display: "flex", alignItems: "center", justifyContent: "space-between" },
  brand: { fontWeight: 700, fontSize: "1.15rem", color: "#111", textDecoration: "none", letterSpacing: "0.02em" },
  navRight: { display: "flex", alignItems: "center", gap: "1.2rem" },
  navLink: { color: "#555", textDecoration: "none", fontSize: "0.95rem" },
  signInBtn: { color: "#fff", background: "#0070f3", padding: "0.5rem 1rem", borderRadius: 6, textDecoration: "none", fontWeight: 500, fontSize: "0.95rem" },

  hero: { maxWidth: 900, margin: "0 auto", padding: "5rem 1.5rem 3rem", textAlign: "center" },
  h1: { fontSize: "3rem", lineHeight: 1.15, fontWeight: 700, margin: "0 0 1.5rem", letterSpacing: "-0.02em" },
  accent: { color: "#0070f3" },
  subhead: { fontSize: "1.2rem", color: "#555", margin: "0 auto 2rem", maxWidth: 720 },
  ctaRow: { display: "flex", justifyContent: "center", gap: "1rem", flexWrap: "wrap", margin: "0 0 1rem" },
  primaryCta: { color: "#fff", background: "#0070f3", padding: "0.85rem 1.8rem", borderRadius: 6, textDecoration: "none", fontWeight: 600, fontSize: "1rem", display: "inline-block" },
  secondaryCta: { color: "#111", background: "#fff", border: "1px solid #ddd", padding: "0.85rem 1.5rem", borderRadius: 6, textDecoration: "none", fontSize: "1rem", display: "inline-block" },
  microcopy: { color: "#888", fontSize: "0.9rem", margin: "1rem 0 0" },

  section: { maxWidth: 1000, margin: "0 auto", padding: "3rem 1.5rem" },
  h2: { fontSize: "2rem", fontWeight: 600, margin: "0 0 2rem", letterSpacing: "-0.01em" },
  h3: { fontSize: "1.15rem", fontWeight: 600, margin: "0 0 0.6rem" },
  prose: { fontSize: "1.05rem", color: "#333", maxWidth: 780 },

  tableWrap: { overflowX: "auto" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: "0.95rem", background: "#fff", border: "1px solid #e5e5e5", borderRadius: 6 },
  th: { padding: "0.75rem 1rem", textAlign: "left", borderBottom: "1px solid #e5e5e5", background: "#f5f5f5", fontWeight: 600, fontSize: "0.9rem" },
  td: { padding: "0.75rem 1rem", borderBottom: "1px solid #f0f0f0", color: "#444" },
  tdOn: { padding: "0.75rem 1rem", borderBottom: "1px solid #f0f0f0", color: "#0a7c3e", fontWeight: 500 },
  tdOff: { padding: "0.75rem 1rem", borderBottom: "1px solid #f0f0f0", color: "#c1272d" },

  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "1.25rem" },
  card: { background: "#fff", border: "1px solid #e5e5e5", borderRadius: 8, padding: "1.5rem" },
  cardBody: { color: "#555", fontSize: "0.98rem", margin: 0 },
  code: { display: "inline-block", background: "#0f172a", color: "#a5f3fc", padding: "0.5rem 0.9rem", borderRadius: 4, fontSize: "0.9rem", fontFamily: "monospace" },

  faq: { background: "#fff", border: "1px solid #e5e5e5", borderRadius: 6, marginBottom: "0.75rem", padding: "0.9rem 1.2rem" },
  faqSummary: { fontWeight: 600, cursor: "pointer", listStyle: "none", color: "#111" },
  faqAnswer: { marginTop: "0.75rem", color: "#444" },

  footer: { borderTop: "1px solid #e5e5e5", background: "#fff", marginTop: "3rem", padding: "2rem 1.5rem", textAlign: "center" },
  footerText: { color: "#666", fontSize: "0.9rem", margin: 0 },
  footerLink: { color: "#0070f3", textDecoration: "none" },
};
