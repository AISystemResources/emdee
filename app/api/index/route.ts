import { buildIndex, buildIndexFromContents } from "@/src/core/indexer";
import { SupabaseStorage } from "@/src/lib/storage/SupabaseStorage";
import path from "node:path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isPublicPath(p: string): boolean {
  const top = p.split("/")[0];
  const publicRoots = new Set(["EMDEE.md", "VAULT.md", "INFO.md", "INSTRUCTIONS.md", "BRAIN.md", "WORKFLOWS.md", "SAMPLE.md"]);
  const publicDirs = new Set(["sample", "workflows"]);
  return publicRoots.has(p) || publicDirs.has(top);
}

function filterPublic<T extends { docs: { path: string }[]; edges: { from: string; to: string }[] }>(index: T): T {
  const publicDocs = new Set(index.docs.filter((d) => isPublicPath(d.path)).map((d) => d.path));
  return {
    ...index,
    docs: index.docs.filter((d) => publicDocs.has(d.path)),
    edges: index.edges.filter((e) => publicDocs.has(e.from) && publicDocs.has(e.to)),
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const ns = url.searchParams.get("ns") ?? "public";
  const docsDir = process.env.EMDEE_DOCS;

  // Local dev: read from filesystem
  if (docsDir) {
    const index = await buildIndex(path.resolve(docsDir));
    return Response.json(
      ns === "public" ? filterPublic(index) : index,
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  // Cloud: read from Supabase Storage
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return Response.json({ docs: [], edges: [], entry: null }, { headers: { "Cache-Control": "no-store" } });
  }

  const storage = new SupabaseStorage();
  const prefix = `${ns}/`;
  const listed = await storage.list(prefix);

  if (listed.length === 0) {
    return Response.json({ docs: [], edges: [], entry: null }, { headers: { "Cache-Control": "no-store" } });
  }

  const files = await Promise.all(
    listed.map(async (f) => ({
      path: f.path.slice(prefix.length),
      content: (await storage.read(f.path)) ?? "",
    }))
  );

  const index = buildIndexFromContents(files);
  return Response.json(
    ns === "public" ? filterPublic(index) : index,
    { headers: { "Cache-Control": "no-store" } }
  );
}
