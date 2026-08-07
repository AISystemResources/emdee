import { readFile } from "node:fs/promises";
import path from "node:path";
import { adminClient } from "@/src/lib/supabase/admin";
import { SupabaseStorage } from "@/src/lib/storage/SupabaseStorage";

export const dynamic = "force-dynamic";

async function sha256(content: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

// POST /api/sync/resolve
// Body: { action: "keep-local" | "keep-cloud", path: string }
export async function POST(request: Request) {
  const docsDir = process.env.EMDEE_DOCS;
  if (!docsDir) return Response.json({ error: "sync not configured" }, { status: 400 });

  const body = await request.json() as { action: "keep-local" | "keep-cloud"; path: string };
  const { action, path: rel } = body;
  if (!rel || !rel.endsWith(".md")) return Response.json({ error: "invalid path" }, { status: 400 });
  if (action !== "keep-local" && action !== "keep-cloud") {
    return Response.json({ error: "invalid action" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const storage = new SupabaseStorage();

  if (action === "keep-local") {
    const resolved = path.resolve(docsDir, rel);
    const content = await readFile(resolved, "utf8");
    const hash = await sha256(content);
    // SPRINT-189: refuse keep-local when the local doc is empty and the
    // cloud version has content. "Keep local" over an empty local file
    // would silently destroy the cloud content the user was trying to
    // resolve against.
    if (content.trim().length === 0) {
      try {
        const existing = await storage.read(rel);
        if (existing !== null && existing.trim().length > 0) {
          return Response.json({
            error: "empty_local_would_delete_cloud",
            path: rel,
            existing_length: existing.length,
            hint: "Your local copy of this doc is empty but the cloud version has content. Resolve manually — either paste the cloud content locally then re-sync, or use `keep-cloud` to adopt the cloud version.",
          }, { status: 409 });
        }
      } catch {
        // Read failure — fall through, accept the write.
      }
    }
    await storage.write(rel, content);
    await adminClient()
      .from("sync_manifest")
      .upsert({ file_path: rel, content_hash: hash, synced_at: now, clerk_id: null }, { onConflict: "file_path" });
    return Response.json({ ok: true });
  }

  // keep-cloud: fetch from Supabase, overwrite local file, update manifest
  const cloudContent = await storage.read(rel);
  if (!cloudContent) return Response.json({ error: "file not found in cloud" }, { status: 404 });
  const hash = await sha256(cloudContent);

  const { writeFile, mkdir } = await import("node:fs/promises");
  const localPath = path.resolve(docsDir, rel);
  await mkdir(path.dirname(localPath), { recursive: true });
  await writeFile(localPath, cloudContent, "utf8");

  await adminClient()
    .from("sync_manifest")
    .upsert({ file_path: rel, content_hash: hash, synced_at: now, clerk_id: null }, { onConflict: "file_path" });

  return Response.json({ ok: true });
}
