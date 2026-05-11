import { buildIndex } from "../../../core/indexer.js";
import type { ToolContext } from "./types.js";

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export async function listDocs(ctx: ToolContext, _args: Record<string, unknown>): Promise<unknown> {
  const idx = await buildIndex(ctx.docsDir);
  return json(
    idx.docs.map((d) => ({ path: d.path, title: d.title, summary: d.summary }))
  );
}
