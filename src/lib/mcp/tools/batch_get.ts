import { loadVaultIndex, readVaultFile } from "./vault";
import { deriveTitle, deriveSummary } from "../../../core/indexer";
import { extractPreamble } from "./patch_preamble";
import { parseSections, extractBody, hashBody, sectionId } from "./sections";
import { SYSTEM_NODES, SYSTEM_NODE_PATHS, systemNodeContent } from "../../system-nodes";
import type { ToolContext } from "./types";

// SPRINT-123: batch read tools. Motivation: Claude often wants to look
// at 10 docs before deciding which to drill into. 10 individual
// get_summary / get_doc calls pay 10× the tool-call framing overhead.
// A single batch call folds it into one round trip.
//
// Design principles:
// - Best-effort per-path: one missing path returns { path, error } inline
//   instead of failing the whole batch.
// - Envelope-only (no body) for batch_get_doc — full-body batching would
//   defeat the purpose; use individual get_doc(full=true) for that.
// - Capped at 50 paths per call to prevent runaway responses.

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

const MAX_BATCH = 50;

function parsePaths(args: Record<string, unknown>): string[] {
  const raw = args.paths;
  if (!Array.isArray(raw)) return [];
  return raw.filter((p): p is string => typeof p === "string" && p.length > 0).slice(0, MAX_BATCH);
}

export async function batchGetSummary(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const paths = parsePaths(args);
  if (paths.length === 0) return json({ error: "paths_required", hint: "paths must be a non-empty string array (max 50)" });

  const idx = await loadVaultIndex(ctx);
  const byPath = new Map(idx.docs.map((d) => [d.path, d]));

  const results = paths.map((p) => {
    const d = byPath.get(p);
    if (!d) return { path: p, error: "not_found" };
    return { path: d.path, title: d.title, summary: d.summary };
  });

  return json({ count: results.length, results });
}

export async function batchGetDoc(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const paths = parsePaths(args);
  if (paths.length === 0) return json({ error: "paths_required", hint: "paths must be a non-empty string array (max 50)" });

  // Read files in parallel — bounded by MAX_BATCH so we won't blow up.
  const settled = await Promise.all(paths.map(async (rel) => {
    try {
      let content = await readVaultFile(ctx, rel);
      if (content === null) {
        if (SYSTEM_NODE_PATHS.has(rel)) {
          const node = SYSTEM_NODES.find((n) => n.path === rel)!;
          content = systemNodeContent(node);
        } else {
          return { path: rel, error: "not_found" };
        }
      }
      const title = deriveTitle(rel, content);
      const summary = deriveSummary(content);
      const preamble = extractPreamble(content);
      const sections = parseSections(content).map((s, i) => ({
        id: sectionId(s.heading, i),
        heading: s.heading,
        content_hash: hashBody(extractBody(content, s)),
      }));
      return {
        path: rel,
        title,
        summary,
        doc_content_hash: hashBody(content).slice(0, 16),
        preamble,
        sections,
      };
    } catch (err) {
      return { path: rel, error: err instanceof Error ? err.message : String(err) };
    }
  }));

  return json({ count: settled.length, results: settled });
}
