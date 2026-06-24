import Link from "next/link";
import type { ReactNode } from "react";
import { DocNav } from "./DocNav";
import "./docs.css";

export const metadata = {
  title: { template: "%s — EMDEE Docs", default: "EMDEE Docs" },
  description: "Learn how to use EMDEE — a plain-markdown knowledge graph with an MCP interface for Claude.",
};

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="docs-root">
      <header className="docs-header">
        <Link href="/" className="docs-logo">EMDEE</Link>
        <nav className="docs-header-nav">
          <Link href="/" className="docs-header-link">Home</Link>
          <Link href="https://emdee.vercel.app" className="docs-header-cta">
            Open app →
          </Link>
        </nav>
      </header>

      <div className="docs-body">
        <aside className="docs-sidebar">
          <DocNav />
        </aside>
        <main className="docs-main">
          {children}
        </main>
      </div>
    </div>
  );
}
