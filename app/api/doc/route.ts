import path from "node:path";
import { writeFile, mkdir } from "node:fs/promises";

export const dynamic = "force-dynamic";

function safeJoin(base: string, rel: string): string | null {
  const resolved = path.resolve(base, rel);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) return null;
  if (!resolved.endsWith(".md")) return null;
  return resolved;
}

export async function PUT(request: Request) {
  const docsDir = process.env.EMDEE_DOCS;
  if (!docsDir) return new Response("EMDEE_DOCS not set", { status: 500 });

  const url = new URL(request.url);
  const rel = url.searchParams.get("path");
  if (!rel) return new Response("missing path", { status: 400 });

  const resolved = path.resolve(docsDir);
  const file = safeJoin(resolved, rel);
  if (!file) return new Response("invalid path", { status: 400 });

  try {
    const body = await request.text();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body, "utf8");
    return new Response(null, { status: 204 });
  } catch (err) {
    return new Response(`save failed: ${(err as Error).message}`, { status: 500 });
  }
}
