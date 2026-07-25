import { loadVaultIndex } from "./vault";
import type { ToolContext } from "./types";

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function makeSnippet(content: string, query: string, radius = 60): string {
  const i = content.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return "";
  const start = Math.max(0, i - radius);
  const end = Math.min(content.length, i + query.length + radius);
  return (start > 0 ? "…" : "") + content.slice(start, end).replace(/\s+/g, " ").trim() + (end < content.length ? "…" : "");
}

export async function search(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const query = String(args.query ?? "").trim();
  if (!query) return json([]);
  const limit = Math.max(1, Math.min(50, Number(args.limit ?? 10)));
  const compact = args.format === "compact";
  const idx = await loadVaultIndex(ctx);
  const q = query.toLowerCase();
  const scored = idx.docs
    .map((d) => {
      const titleHit = d.title.toLowerCase().includes(q);
      const summaryHit = d.summary.toLowerCase().includes(q);
      const contentHit = d.content.toLowerCase().includes(q);
      if (!titleHit && !summaryHit && !contentHit) return null;
      const score = (titleHit ? 3 : 0) + (summaryHit ? 2 : 0) + (contentHit ? 1 : 0);
      return { score, d, titleHit };
    })
    .filter((x): x is { score: number; d: typeof idx.docs[number]; titleHit: boolean } => x !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  // SPRINT-121: compact mode returns only { path, title } — ~80% token
  // reduction vs full envelope (summary + snippet dropped). Callers who
  // need more can chain get_summary or get_doc per path.
  if (compact) {
    return json(scored.map((x) => ({ path: x.d.path, title: x.d.title })));
  }
  return json(scored.map((x) => ({
    path: x.d.path,
    title: x.d.title,
    summary: x.d.summary,
    snippet: x.titleHit ? "" : makeSnippet(x.d.content, query),
  })));
}
