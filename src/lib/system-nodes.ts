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
    summary: "Your knowledge graph, in markdown — the root of your vault.",
  },
  {
    path: "VAULT.md",
    title: "VAULT",
    summary: "Your private notes, projects, and knowledge.",
  },
  {
    path: "SHARED.md",
    title: "SHARED",
    summary: "Content shared with you by others.",
  },
  {
    path: "GRAVEYARD.md",
    title: "GRAVEYARD",
    summary: "Archived and retired documents.",
  },
  {
    path: "IMAGES.md",
    title: "IMAGES",
    summary: "Images and visual assets.",
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
