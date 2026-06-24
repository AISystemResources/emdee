import type { Metadata } from "next";

export const metadata: Metadata = { title: "Overview" };

export default function OverviewPage() {
  return (
    <article>
      <p className="docs-eyebrow">Get Started</p>
      <h1 className="docs-h1">Overview</h1>

      <p className="docs-lead">
        EMDEE is a plain-markdown knowledge graph with two interfaces: a web
        renderer for human reading, and an MCP server for AI agents. Your vault
        lives in plain <code className="docs-code">.md</code> files — readable
        anywhere, owned by you.
      </p>

      <div className="docs-callout">
        <p>
          <strong>The big idea.</strong> Your knowledge graph is the product. Write
          a note, connect it to what you already know, and ask Claude to reason
          across it — all without leaving your editor or changing how you write.
        </p>
      </div>

      <h2 className="docs-h2">How it works</h2>

      <p className="docs-p">
        Every document in your vault is a Markdown file with a simple structure: a
        title, a one-line summary, and a set of sections. Two special sections —{" "}
        <code className="docs-code">## Child of</code> and{" "}
        <code className="docs-code">## Parent of</code> — encode the edges of your
        knowledge graph using wiki-links like{" "}
        <code className="docs-code">[[DOCUMENT]]</code>.
      </p>

      <p className="docs-p">
        EMDEE reads those links and materialises a graph in the database. The web
        app renders it as an interactive Cytoscape graph. The MCP server exposes it
        as tools Claude can call — so your AI can read, write, search, and traverse
        your vault during any conversation.
      </p>

      <h2 className="docs-h2">Two ways to use it</h2>

      <h3 className="docs-h3">From Claude (recommended)</h3>
      <p className="docs-p">
        Connect your vault to Claude.ai or any MCP-compatible client via the
        cloud link at{" "}
        <code className="docs-code">emdee.tech/cloud-link</code>. Once
        connected, Claude can call tools like{" "}
        <code className="docs-code">get_doc</code>,{" "}
        <code className="docs-code">search</code>,{" "}
        <code className="docs-code">create_child</code>, and{" "}
        <code className="docs-code">patch_section</code> to read and write your
        vault in real time.
      </p>

      <h3 className="docs-h3">From the web app</h3>
      <p className="docs-p">
        Sign in at <code className="docs-code">emdee.tech</code> to browse
        your vault as a document tree or an interactive graph, create and edit
        docs, share public links, and manage your vault structure.
      </p>

      <h2 className="docs-h2">Core concepts</h2>

      <ul className="docs-ul">
        <li>
          <strong>Vault</strong> — your personal namespace. All documents live under
          a single root node (<code className="docs-code">EMDEE.md</code>) with four
          top-level hubs: <code className="docs-code">VAULT</code>,{" "}
          <code className="docs-code">GRAVEYARD</code>,{" "}
          <code className="docs-code">IMAGES</code>, and your owner node (e.g.{" "}
          <code className="docs-code">EDMUND</code>).
        </li>
        <li>
          <strong>Hub + folder</strong> — every hub document gets a matching
          lowercase subfolder. <code className="docs-code">PROJECTS.md</code> stores
          its children in <code className="docs-code">projects/</code>. This keeps
          the vault browsable as a plain directory.
        </li>
        <li>
          <strong>Edges</strong> — hierarchy edges (<code className="docs-code">Child of</code>{" "}
          /{" "}<code className="docs-code">Parent of</code>) define the tree.
          Association edges (<code className="docs-code">Associated with</code>)
          add non-hierarchical links. The graph is always derivable from the
          markdown.
        </li>
        <li>
          <strong>MCP tools</strong> — <code className="docs-code">get_doc</code>,{" "}
          <code className="docs-code">search</code>,{" "}
          <code className="docs-code">create_child</code>,{" "}
          <code className="docs-code">patch_section</code>,{" "}
          <code className="docs-code">move_doc</code>, and more. All tools operate
          within your namespace and respect vault conventions.
        </li>
      </ul>
    </article>
  );
}
