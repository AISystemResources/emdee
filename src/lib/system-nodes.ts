// The 5 canonical OS-layer nodes that exist in every vault by default.
// These are never stored per-user — they're injected as virtual docs at
// index-build time so they always appear even for users who've never written
// to them. Updating content here takes effect for all users immediately.
// If a user has customised a node (written it via MCP), their stored version
// takes precedence because the injection is skipped when the path is present
// in the listed files.

export interface SystemNode {
  path: string;
  title: string;
  summary: string;
}

export const SYSTEM_NODES: readonly SystemNode[] = [
  {
    path: "EMDEE.md",
    title: "EMDEE",
    summary: "Root of your Emdee vault. Every doc hangs off this anchor — the system layer under [[VAULT]], your personal content under your owner node, shared docs under [[SHARED]], archived docs under [[GRAVEYARD]], images under [[IMAGES]].",
  },
  {
    path: "VAULT.md",
    title: "VAULT",
    summary: "System layer for Emdee — vault mechanics every Emdee user shares (system-shipped skills, workflows, automation routines). Deliberately narrow: your personal content lives under your owner node, not here.",
  },
  {
    path: "SHARED.md",
    title: "SHARED",
    summary: "Docs other users have shared into your vault. Visible to your MCP tools and renderer; the content lives in the owner's vault and is read-only here.",
  },
  {
    path: "GRAVEYARD.md",
    title: "GRAVEYARD",
    summary: "Archived and retired docs. Soft-deletion target — occupants remain readable and fully restorable via `restore_doc`, but are filtered from active reading views.",
  },
  {
    path: "IMAGES.md",
    title: "IMAGES",
    summary: "Central image library. Every image uploaded via drag-and-drop or the upload_image MCP tool lives here as a child doc holding the image URL and a description.",
  },
] as const;

export const SYSTEM_NODE_PATHS = new Set(SYSTEM_NODES.map((n) => n.path));

export function systemNodeContent(node: SystemNode): string {
  // EMDEE is the root — no parent. All other system nodes are children of EMDEE.
  const childOf = node.path !== "EMDEE.md" ? "\n## Child of\n\n* [[EMDEE]]\n" : "";
  return `# ${node.title}\n\n> ${node.summary}\n${childOf}`;
}

/**
 * Return `{path, content}` entries for any system node NOT already present
 * in `existingPaths`. Cloud + local index builders append these before the
 * indexer runs so wiki-link resolution + doc listing sees the canonical
 * 5-node OS layer without ever writing them to disk.
 */
export function missingSystemNodeFiles(
  existingPaths: Iterable<string>,
): { path: string; content: string }[] {
  const present = new Set(existingPaths);
  const out: { path: string; content: string }[] = [];
  for (const node of SYSTEM_NODES) {
    if (!present.has(node.path)) {
      out.push({ path: node.path, content: systemNodeContent(node) });
    }
  }
  return out;
}
