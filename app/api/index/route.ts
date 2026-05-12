import { buildIndex } from "@/src/core/indexer";
import path from "node:path";

export const dynamic = "force-dynamic";

export async function GET() {
  const docsDir = process.env.EMDEE_DOCS;
  if (!docsDir) {
    return Response.json({ docs: [], edges: [], entry: null }, {
      headers: { "Cache-Control": "no-store" },
    });
  }
  const index = await buildIndex(path.resolve(docsDir));
  return Response.json(index, {
    headers: { "Cache-Control": "no-store" },
  });
}
