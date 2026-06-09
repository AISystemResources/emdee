import { auth } from "@clerk/nextjs/server";
import { adminClient } from "@/src/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// All media lands in vault-images for now. vault-media (or per-type buckets)
// will be added when audio/video actually arrives.
const MEDIA_BUCKET = "vault-images";

const ROLE_VALUES = [
  "cover", "hero", "screenshot", "thumbnail", "og-image",
  "logo", "icon", "avatar", "diagram", "banner", "gallery",
] as const;
type MediaRole = (typeof ROLE_VALUES)[number];

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
};

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
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

  const ext = MIME_TO_EXT[file.type];
  if (!ext) return Response.json({ error: `unsupported type: ${file.type}` }, { status: 400 });

  const roleRaw = String(formData.get("role") ?? "").trim();
  if (!(ROLE_VALUES as readonly string[]).includes(roleRaw)) {
    return Response.json({
      error: `role must be one of: ${ROLE_VALUES.join(", ")}`,
    }, { status: 400 });
  }
  const role = roleRaw as MediaRole;

  const subjectRaw = String(formData.get("subject") ?? "").trim();
  if (!subjectRaw) return Response.json({ error: "subject is required" }, { status: 400 });
  const subject = slugify(subjectRaw);
  if (!subject) return Response.json({ error: "subject must contain at least one alphanumeric character" }, { status: 400 });

  const variantRaw = String(formData.get("variant") ?? "").trim();
  const variant = variantRaw ? slugify(variantRaw) : null;

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const nameParts = [role, subject, ...(variant ? [variant] : []), ts];
  const filename = `${nameParts.join("-")}.${ext}`;
  const storagePath = `${userId}/${filename}`;

  const bytes = await file.arrayBuffer();
  const buffer = Buffer.from(bytes);

  const { error: uploadErr } = await adminClient()
    .storage
    .from(MEDIA_BUCKET)
    .upload(storagePath, buffer, { contentType: file.type, upsert: false });

  if (uploadErr) {
    return Response.json({ error: `upload failed: ${uploadErr.message}` }, { status: 500 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const publicUrl = `${supabaseUrl}/storage/v1/object/public/${MEDIA_BUCKET}/${storagePath}`;

  return Response.json({ public_url: publicUrl, storage_path: storagePath });
}
