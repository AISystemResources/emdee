import type { Metadata } from "next";

export const metadata: Metadata = { title: "Quickstart" };

export default function QuickstartPage() {
  return (
    <article>
      <p className="docs-eyebrow">Get Started</p>
      <h1 className="docs-h1">Quickstart</h1>

      <p className="docs-lead">
        Get your vault live and connected to Claude in under five minutes.
      </p>

      <h2 className="docs-h2">1. Create an account</h2>

      <div className="docs-step">
        <div className="docs-step-num">1</div>
        <div className="docs-step-body">
          <strong>Sign in at emdee.vercel.app</strong>
          <p>
            Click <em>Sign in</em> and create an account with Google or email. Your
            vault is provisioned automatically — you land straight in the graph view.
          </p>
        </div>
      </div>

      <div className="docs-step">
        <div className="docs-step-num">2</div>
        <div className="docs-step-body">
          <strong>Explore the starter vault</strong>
          <p>
            Your vault starts with five root nodes:{" "}
            <code className="docs-code">EMDEE</code>,{" "}
            <code className="docs-code">VAULT</code>,{" "}
            <code className="docs-code">GRAVEYARD</code>,{" "}
            <code className="docs-code">IMAGES</code>, and your owner node.
            Click any node to open the document.
          </p>
        </div>
      </div>

      <h2 className="docs-h2">2. Connect Claude</h2>

      <div className="docs-step">
        <div className="docs-step-num">3</div>
        <div className="docs-step-body">
          <strong>Get your MCP connection link</strong>
          <p>
            Go to <code className="docs-code">emdee.vercel.app/cloud-link</code>.
            Click <em>Connect to Claude.ai</em>. This authorises Claude to read
            and write your vault via the MCP protocol.
          </p>
        </div>
      </div>

      <div className="docs-step">
        <div className="docs-step-num">4</div>
        <div className="docs-step-body">
          <strong>Verify the connection</strong>
          <p>
            In Claude, start a new conversation and ask:{" "}
            <code className="docs-code">list my vault docs</code>. Claude will
            call <code className="docs-code">list_docs</code> and return your
            root-level files.
          </p>
        </div>
      </div>

      <h2 className="docs-h2">3. Create your first document</h2>

      <div className="docs-step">
        <div className="docs-step-num">5</div>
        <div className="docs-step-body">
          <strong>Ask Claude to create a doc</strong>
          <p>
            Tell Claude: <em>&ldquo;Create a doc called READING-LIST as a child of my
            owner node.&rdquo;</em> Claude calls{" "}
            <code className="docs-code">create_child</code> — the doc appears in
            your vault instantly.
          </p>
        </div>
      </div>

      <div className="docs-step">
        <div className="docs-step-num">6</div>
        <div className="docs-step-body">
          <strong>Or create one from the web app</strong>
          <p>
            Click <em>+ New doc</em> in the sidebar. Pick a parent node, give it a
            title, and save. The edge is created automatically.
          </p>
        </div>
      </div>

      <div className="docs-callout">
        <p>
          <strong>Tip.</strong> Ask Claude to read{" "}
          <code className="docs-code">INFO.md</code> in your vault — it contains
          the conventions your vault follows and helps Claude write docs that fit
          your structure.
        </p>
      </div>

      <h2 className="docs-h2">What&apos;s next</h2>

      <ul className="docs-ul">
        <li>Build a project hub — create a <code className="docs-code">PROJECTS.md</code> node and start adding children under it</li>
        <li>Use <code className="docs-code">search</code> to find anything across your vault by keyword or concept</li>
        <li>Share a public link — open any doc, click <em>Share</em>, and send a read-only URL</li>
        <li>Run the graph view to see how your knowledge is connected</li>
      </ul>
    </article>
  );
}
