import { loadVaultIndex } from "./vault";
import type { ToolContext } from "./types";

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

export async function getSummary(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const idx = await loadVaultIndex(ctx);
  const doc = idx.docs.find((d) => d.path === String(args.path));
  if (!doc) throw new Error(`no such doc: ${args.path}`);
  if (args.format === "text") return text(doc.summary ?? "");
  return json({ path: doc.path, title: doc.title, summary: doc.summary });
}
