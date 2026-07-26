import { adminClient } from "../../supabase/admin";
import { cloudDatabase } from "../../database";
import { readVaultFile } from "./vault";
import type { ToolContext } from "./types";

// SPRINT-122b: Postgres FTS-based "similar docs" lookup. Ships as the
// association-density multiplier without embeddings, without LLM
// wrappers, without ongoing cost.
//
// Mechanism: source doc's title + summary + first 2000 chars of body
// become a websearch_to_tsquery. We ts_rank every other doc's stored
// content_tsv (generated column, GIN-indexed) against that query.
// Returns top-K by rank.
//
// Limits vs semantic embeddings:
// - Catches shared vocabulary (whitepaper A about "attention" ≈ B about "attention")
// - Misses synonym bridges (A about "attention mechanism" ≠ B about "transformer focus")
// The tradeoff Edmund accepted (SPRINT-121 discussion): lightweight or
// nothing. This is the lightweight side.
//
// Cloud-only — depends on Postgres tsvector column.

interface SimilarDoc {
  path: string;
  title: string;
  summary: string;
  rank: number;
}

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function deriveTitle(rel: string, content: string): string {
  const m = content.match(/^#\s+(.+)$/m);
  if (m) return m[1].trim();
  const last = rel.split("/").pop() ?? rel;
  return last.replace(/\.md$/i, "");
}

function deriveSummary(content: string): string {
  const m = content.match(/^>\s+([\s\S]+?)(?:\n\n|\n$)/m);
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

export async function findSimilar(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  if (ctx.mode !== "cloud") {
    return json({
      error: "cloud_mode_required",
      hint: "find_similar depends on Postgres tsvector; local mode has no equivalent index.",
    });
  }

  const path = typeof args.path === "string" && args.path.length > 0 ? args.path : null;
  if (!path) return json({ error: "path_required" });

  const limit = Math.max(1, Math.min(50, Number(args.limit ?? 10)));

  // Read source content — canonical from Storage, so we don't need to
  // join vault_files here.
  const content = await readVaultFile(ctx, path);
  if (content === null) return json({ error: "source_doc_not_found", path });

  // Build query from title + summary + head of body. Truncated to keep
  // the tsquery reasonable; long queries blow up ts_rank cost.
  const title = deriveTitle(path, content);
  const summary = deriveSummary(content);
  const head = content.slice(0, 2000);
  const queryText = `${title} ${summary} ${head}`.replace(/[^\w\s]/g, " ").slice(0, 4000);

  // SPRINT-139: search through VaultDatabase (backends that don't
  // support FTS return empty; SupabasePostgres uses tsvector column
  // from migration 20260725000001).
  const db = ctx.db ?? cloudDatabase();
  const rows = await db.searchFiles(ctx.userId, queryText, limit, path);
  const results: SimilarDoc[] = rows.map((r) => {
    const c = r.content ?? "";
    return {
      path: r.file_path,
      title: deriveTitle(r.file_path, c),
      summary: deriveSummary(c),
      rank: 0,
    };
  });

  return json({ ok: true, source_path: path, count: results.length, results });
}
