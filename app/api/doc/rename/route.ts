import { auth } from "@clerk/nextjs/server";
import { SupabaseStorage } from "@/src/lib/storage/SupabaseStorage";
import { renameDoc } from "@/src/lib/mcp/tools/rename_doc";
import type { ToolContext } from "@/src/lib/mcp/tools/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/doc/rename { oldPath, newTitle, newPath? }
 *
 * Server-side wrapper around the shared renameDoc helper so the Web UI
 * can drive the same atomic rename the MCP `rename_doc` tool exposes.
 * Local-dev mode (EMDEE_DOCS) skips auth and runs against the filesystem.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.oldPath !== "string" || typeof body.newTitle !== "string") {
    return Response.json({ error: "oldPath and newTitle required" }, { status: 400 });
  }
  const oldPath = body.oldPath as string;
  const newTitle = (body.newTitle as string).trim();
  const newPath = typeof body.newPath === "string" ? body.newPath.trim() : undefined;

  const docsDir = process.env.EMDEE_DOCS;
  let ctx: ToolContext;
  if (docsDir) {
    const path = await import("node:path");
    ctx = { mode: "local", docsDir: path.resolve(docsDir) };
  } else {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 });
    ctx = { mode: "cloud", storage: new SupabaseStorage(), userId };
  }

  try {
    const result = await renameDoc(ctx, { old_path: oldPath, new_title: newTitle, new_path: newPath });
    // renameDoc returns the MCP envelope {content:[{type:"text",text:json}]} —
    // unwrap for the HTTP caller.
    const text = (result as { content: Array<{ text: string }> }).content?.[0]?.text;
    const parsed = text ? JSON.parse(text) : result;
    const status = parsed?.error ? 400 : 200;
    return Response.json(parsed, { status });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
