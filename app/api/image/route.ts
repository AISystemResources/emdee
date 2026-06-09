import { auth } from "@clerk/nextjs/server";
import { adminClient } from "@/src/lib/supabase/admin";
import { SupabaseStorage } from "@/src/lib/storage/SupabaseStorage";
import { createChild, addAssociation } from "@/src/lib/mcp/tools/index";
import type { ToolContext } from "@/src/lib/mcp/tools/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const IMAGE_BUCKET = "vault-images";
const IMAGES_HUB = "images/IMAGES.md";

const SUPPORTED_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function sanitizeTitle(s: string): string {
  return s.trim().replace(/[^A-Za-z0-9 \-_.—]+/g, " ").replace(/\s+/g, " ").trim() || "Image";
}

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) return new Response("Unauthorized", { status: 401 });

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json({ error: "invalid form data" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) return Response.json({ error: "file is required" }, { status: 400 });

  const ext = SUPPORTED_TYPES[file.type];
  if (!ext) return Response.json({ error: `unsupported type: ${file.type}` }, { status: 400 });

  const associatePathRaw = formData.get("associatePath");
  const associatePath = typeof associatePathRaw === "string" && associatePathRaw.trim()
    ? associatePathRaw.trim() : null;

  const titleRaw = formData.get("title");
  const titleStr = sanitizeTitle(
    typeof titleRaw === "string" && titleRaw.trim()
      ? titleRaw.trim()
      : file.name.replace(/\.[^.]+$/, "")
  );

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `${ts}.${ext}`;
  const storagePath = `${userId}/${filename}`;

  const bytes = await file.arrayBuffer();
  const buffer = Buffer.from(bytes);

  const { error: uploadErr } = await adminClient()
    .storage
    .from(IMAGE_BUCKET)
    .upload(storagePath, buffer, { contentType: file.type, upsert: false });

  if (uploadErr) {
    return Response.json({ error: `upload failed: ${uploadErr.message}` }, { status: 500 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const imageUrl = `${supabaseUrl}/storage/v1/object/public/${IMAGE_BUCKET}/${storagePath}`;

  const storage = new SupabaseStorage();
  const ctx: ToolContext = { mode: "cloud", storage, userId };

  const slug = slugify(titleStr) || "image";
  const timeSuffix = ts.slice(11, 19); // HH-MM-SS
  const docPath = `images/${slug}-${timeSuffix}.md`;
  // Include time suffix in title so repeated pastes of "image.png" don't collide.
  const childTitle = `${titleStr} ${timeSuffix}`;

  const childResult = await createChild(ctx, {
    parent_path: IMAGES_HUB,
    title: childTitle,
    child_path: docPath,
    summary: "_description pending_",
    body: `\n![${titleStr}](${imageUrl})\n`,
  }) as { error?: string };

  if (childResult?.error) {
    return Response.json({ error: `vault doc creation failed: ${childResult.error}` }, { status: 500 });
  }

  if (associatePath) {
    await (addAssociation(ctx, { a_path: docPath, b_path: associatePath }) as Promise<unknown>).catch(() => {});
  }

  return Response.json({ doc_path: docPath, image_url: imageUrl, doc_created: true });
}
