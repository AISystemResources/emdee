import { loadVaultIndex } from "./vault";
import type { ToolContext } from "./types";

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

export async function listDocs(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const idx = await loadVaultIndex(ctx);
  if (args.format === "text") {
    return text(idx.docs.map((d) => d.path).join("\n"));
  }
  // SPRINT-121: compact drops summary — ~60% smaller for enumerate-then-decide
  // workflows. Callers who want summaries chain get_summary per path.
  if (args.format === "compact") {
    return json(idx.docs.map((d) => ({ path: d.path, title: d.title })));
  }
  return json(idx.docs.map((d) => ({ path: d.path, title: d.title, summary: d.summary })));
}
