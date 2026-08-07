import { SupabaseStorage } from "@/src/lib/storage/SupabaseStorage";
import { auth } from "@clerk/nextjs/server";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { adminClient } from "@/src/lib/supabase/admin";
import { ensureProfile } from "@/src/lib/supabase/oauth";

export const dynamic = "force-dynamic";

async function walk(dir: string, base: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full, base)));
    else if (e.isFile() && e.name.endsWith(".md")) out.push(path.relative(base, full));
  }
  return out;
}

async function sha256(content: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ConflictFile {
  path: string;
  localHash: string;
  cloudUploadedAt: string;
  manifestSyncedAt: string;
}

// POST /api/sync — uploads local docs to Supabase Storage under the user's namespace.
// Namespace is the Clerk userId. Returns { synced, files } or { conflicts }.
// Pass ?force=true to skip conflict detection.
export async function POST(request: Request) {
  const docsDir = process.env.EMDEE_DOCS;
  const url = new URL(request.url);
  const force = url.searchParams.get("force") === "true";
  // ns param lets the CLI specify "public" namespace; web app uses the Clerk userId
  const nsParam = url.searchParams.get("ns");

  if (!docsDir) return Response.json({ error: "EMDEE_DOCS not set" }, { status: 400 });

  // Resolve namespace: explicit ?ns param (for CLI) or Clerk userId (for web)
  let ns: string;
  if (nsParam) {
    ns = nsParam;
  } else {
    const { userId } = await auth();
    if (!userId) return Response.json({ error: "not authenticated" }, { status: 401 });
    ns = userId;
  }

  const resolved = path.resolve(docsDir);
  try { await stat(resolved); } catch {
    return Response.json({ error: "docs directory not found" }, { status: 400 });
  }

  const files = await walk(resolved, resolved);
  const namespacedPaths = files.map((rel) => `${ns}/${rel}`);

  // Read all local files and compute hashes
  const localFiles = await Promise.all(
    files.map(async (rel) => {
      const content = await readFile(path.join(resolved, rel), "utf8");
      const hash = await sha256(content);
      return { rel, namespacedPath: `${ns}/${rel}`, content, hash };
    })
  );

  const storage = new SupabaseStorage();

  if (!force) {
    const { data: manifest } = await adminClient()
      .from("sync_manifest")
      .select("file_path, content_hash, synced_at")
      .in("file_path", namespacedPaths);

    const manifestByPath = new Map(
      (manifest ?? []).map((r: { file_path: string; content_hash: string; synced_at: string }) => [r.file_path, r])
    );

    const cloudFiles = await storage.list(`${ns}/`);
    const cloudByPath = new Map(cloudFiles.map((f) => [f.path, f]));

    const conflicts: ConflictFile[] = [];
    for (const { rel, namespacedPath, hash } of localFiles) {
      const manifest_row = manifestByPath.get(namespacedPath);
      if (!manifest_row) continue;

      const localChanged = hash !== manifest_row.content_hash;
      const cloudFile = cloudByPath.get(namespacedPath);
      const cloudChanged = cloudFile
        ? new Date(cloudFile.updatedAt) > new Date(manifest_row.synced_at)
        : false;

      if (localChanged && cloudChanged) {
        conflicts.push({
          path: rel,
          localHash: hash,
          cloudUploadedAt: cloudFile!.updatedAt,
          manifestSyncedAt: manifest_row.synced_at,
        });
      }
    }

    if (conflicts.length > 0) return Response.json({ conflicts });
  }

  const now = new Date().toISOString();
  // sync_manifest.clerk_id has a FK to profiles.clerk_id; make sure the row
  // exists before the upsert (a first-time user may not have one yet).
  if (ns !== "public") await ensureProfile(ns);

  // SPRINT-189: skip empty-content writes that would blank a non-empty
  // existing cloud doc. Same class as the SPRINT-187 editor-autosave
  // guard — the CLI `emdee sync` push path was another storage-write
  // bypass we hadn't covered. Failure to sync one file is a warning,
  // not a full-batch failure; the manifest still records what did sync.
  const skipped: Array<{ path: string; reason: string }> = [];
  const toWrite: Array<{ namespacedPath: string; content: string; hash: string }> = [];
  await Promise.all(
    localFiles.map(async (f) => {
      if (f.content.trim().length === 0) {
        try {
          const existing = await storage.read(f.namespacedPath);
          if (existing !== null && existing.trim().length > 0) {
            skipped.push({ path: f.rel, reason: "empty_would_delete_existing_content" });
            return;
          }
        } catch {
          // Read failure — fall through and accept the write.
        }
      }
      toWrite.push(f);
    })
  );
  await Promise.all(toWrite.map(({ namespacedPath, content }) => storage.write(namespacedPath, content)));

  // Only manifest-record what actually wrote — skipping an empty push
  // must not advance the manifest, or the next sync will treat cloud
  // (which still has the real content) as "unchanged" and never pull.
  const skippedPaths = new Set(skipped.map((s) => `${ns}/${s.path}`));
  const upsertRows = localFiles
    .filter(({ namespacedPath }) => !skippedPaths.has(namespacedPath))
    .map(({ namespacedPath, hash }) => ({
      file_path: namespacedPath,
      content_hash: hash,
      synced_at: now,
      clerk_id: ns === "public" ? null : ns,
    }));
  if (upsertRows.length > 0) {
    await adminClient()
      .from("sync_manifest")
      .upsert(upsertRows, { onConflict: "file_path" });
  }

  return Response.json({ synced: upsertRows.length, skipped, files });
}

// GET /api/sync — returns whether sync is available (EMDEE_DOCS + Supabase configured)
export async function GET() {
  const canSync = !!(process.env.EMDEE_DOCS && (process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY));
  return Response.json({ canSync });
}
