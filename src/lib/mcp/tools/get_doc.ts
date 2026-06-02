import { validatePath, readVaultFile } from "./vault";
import { extractPreamble } from "./patch_preamble";
import { parseSections, extractBody, hashBody, sectionId } from "./sections";
import { deriveTitle, deriveSummary } from "@/src/core/indexer";
import type { ToolContext } from "./types";

// Re-export sectionId so historic call sites (`import { sectionId } from "./get_doc"`)
// keep compiling without an audit-the-world rename.
export { sectionId } from "./sections";

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
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
  const content = await readVaultFile(ctx, rel);
  if (content === null) throw new Error(`no such doc: ${rel}`);

  const docHash = hashBody(content);

  const expected = args.expected_content_hash !== undefined ? String(args.expected_content_hash) : "";
  if (expected && expected === docHash) {
    return json({ unchanged: true, path: rel, doc_content_hash: docHash });
  }

  const full = Boolean(args.full);
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
