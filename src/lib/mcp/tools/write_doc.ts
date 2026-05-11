import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { ToolContext } from "./types.js";

function safeResolve(docsDir: string, rel: string): string {
  const resolved = path.resolve(docsDir, rel);
  if (!resolved.startsWith(docsDir)) throw new Error("path escapes docs directory");
  return resolved;
}

export async function writeDoc(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const file = safeResolve(ctx.docsDir, String(args.path));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, String(args.content ?? ""), "utf8");
  return { content: [{ type: "text", text: `wrote ${args.path}` }] };
}
