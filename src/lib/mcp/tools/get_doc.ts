import { validatePath, readVaultFile } from "./vault";
import { extractPreamble } from "./patch_preamble";
import { parseSections, extractBody, hashBody, sectionId } from "./sections";
import { deriveTitle, deriveSummary } from "@/src/core/indexer";
import type { ToolContext } from "./types";
import { SYSTEM_NODES, SYSTEM_NODE_PATHS, systemNodeContent } from "@/src/lib/system-nodes";

// Re-export sectionId so historic call sites (`import { sectionId } from "./get_doc"`)
// keep compiling without an audit-the-world rename.
export { sectionId } from "./sections";

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

/**
 * Return doc metadata. SPRINT-018 Phase 5: the body is opt-in via
 * `full=true`. The default response is light — title + summary +
 * preamble + section headings.
 *
 * SPRINT-024 Phase 1: every response now carries `doc_content_hash`
 * (sha256 first 16 hex of the raw file content). Pass it back via
 * `expected_content_hash` on the next get_doc; if the doc hasn't
 * changed we return `{ unchanged: true, path, doc_content_hash }` and
 * skip the section-parse / preamble work entirely. Cheaper than fetching
 * the doc just to discover nothing moved.
 *
 * SPRINT-038 v1: read the file directly via `readVaultFile` instead of
 * pulling the full vault index. Title + summary are derived locally with
 * the same primitives the indexer uses, so the response shape is
 * byte-identical to the prior `loadVaultIndex` path. The cold-start win
 * is avoiding the `listWithContent` cascade for a known-path lookup.
 */
export async function getDoc(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const rel = String(args.path);
  validatePath(rel);
  let content = await readVaultFile(ctx, rel);
  if (content === null) {
    // Virtual system nodes are never stored per-user — serve their canonical
    // content so MCP callers can read EMDEE/VAULT/SHARED/GRAVEYARD/IMAGES.
    if (SYSTEM_NODE_PATHS.has(rel)) {
      const node = SYSTEM_NODES.find((n) => n.path === rel)!;
      content = systemNodeContent(node);
    } else {
      throw new Error(`no such doc: ${rel}`);
    }
  }

  const docHash = hashBody(content);

  const expected = args.expected_content_hash !== undefined ? String(args.expected_content_hash) : "";
  if (expected && expected === docHash) {
    return json({ unchanged: true, path: rel, doc_content_hash: docHash });
  }

  const full = Boolean(args.full);

  // Plaintext mode short-circuit: bare markdown, no envelope.
  // full=true → raw file. full=false → H1 + summary + section headings.
  if (args.format === "text") {
    if (full) return text(content);
    const title = deriveTitle(rel, content);
    const summary = deriveSummary(content);
    const headings = parseSections(content).map((s) => `## ${s.heading}`);
    const parts = [`# ${title}`];
    if (summary) parts.push(`> ${summary}`);
    if (headings.length) parts.push(headings.join("\n"));
    return text(parts.join("\n\n"));
  }

  const sections = parseSections(content).map((s, idx) => ({
    id: sectionId(s.heading, idx),
    heading: s.heading,
    content_hash: hashBody(extractBody(content, s)),
  }));
  const preamble = extractPreamble(content);
  const payload: Record<string, unknown> = {
    path: rel,
    title: deriveTitle(rel, content),
    summary: deriveSummary(content),
    doc_content_hash: docHash,
    preamble: preamble ?? undefined,
    sections,
  };
  if (full) payload.content = content;
  return json(payload);
}
