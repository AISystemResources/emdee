import sharp from "sharp";
import { adminClient } from "../../supabase/admin";
import { writeVaultFile } from "./vault";
import type { ToolContext } from "./types";

const IMAGE_BUCKET = "vault-images";

// SPRINT-168: added image/svg+xml so Claude Code agents can upload
// generated diagrams inline.
// SPRINT-169: SVG uploads auto-rasterise to PNG alongside the SVG
// source. LinkedIn (and most social feeds) doesn't render SVG inline;
// blog readers and the vault renderer prefer SVG. Storing both lets
// the doc embed the PNG (broad compatibility) while linking the SVG
// (crisp source of truth). Pass `rasterize: false` to skip.
const SUPPORTED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
] as const;
type SupportedMediaType = (typeof SUPPORTED_TYPES)[number];

// SPRINT-169: bump this when the PNG output size feels wrong for
// social feeds. 1200 lines up with LinkedIn's preferred image width.
const RASTER_WIDTH = 1200;

function ext(mediaType: SupportedMediaType): string {
  const map: Record<SupportedMediaType, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
  };
  return map[mediaType];
}

function slugify(s: string): string {
  // SPRINT-055 (SIG-004): uppercase filenames are project convention.
  return s.toUpperCase().trim().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export async function uploadImage(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  if (ctx.mode === "local") {
    return json({ error: "upload_image requires cloud mode — not available in local (stdio) mode" });
  }

  const imageData = String(args.image_data ?? "");
  const mediaType = String(args.media_type ?? "") as SupportedMediaType;
  const titleArg = args.title !== undefined ? String(args.title) : null;
  const description = args.description !== undefined ? String(args.description) : "";
  const pathArg = args.path !== undefined ? String(args.path) : null;
  const rasterize = args.rasterize !== false;

  if (!imageData) return json({ error: "image_data is required" });
  if (!(SUPPORTED_TYPES as readonly string[]).includes(mediaType)) {
    return json({ error: `unsupported media_type — must be one of: ${SUPPORTED_TYPES.join(", ")}` });
  }

  let imageBuffer: Buffer;
  try {
    imageBuffer = Buffer.from(imageData, "base64");
  } catch {
    return json({ error: "image_data is not valid base64" });
  }
  if (imageBuffer.length === 0) return json({ error: "image_data decoded to empty buffer" });

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  // Prefer a slugified title in the storage filename so uploads are
  // recognisable in Supabase / URLs. Fall back to timestamp when no
  // title given. Timestamp suffix on the slug keeps collisions rare
  // (upsert: false rejects same-key writes).
  const baseName = titleArg ? `${slugify(titleArg)}-${ts.slice(0, 10)}` : ts;
  const filename = `${baseName}.${ext(mediaType)}`;
  const storagePath = `${ctx.userId}/${filename}`;

  const { error: uploadErr } = await adminClient()
    .storage
    .from(IMAGE_BUCKET)
    .upload(storagePath, imageBuffer, { contentType: mediaType, upsert: false });

  if (uploadErr) return json({ error: `storage upload failed: ${uploadErr.message}` });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const imageUrl = `${supabaseUrl}/storage/v1/object/public/${IMAGE_BUCKET}/${storagePath}`;

  // SPRINT-169: rasterise SVGs → PNG for feeds that don't render SVG.
  let pngUrl: string | null = null;
  let rasterErr: string | null = null;
  if (mediaType === "image/svg+xml" && rasterize) {
    try {
      const pngBuffer = await sharp(imageBuffer)
        .resize({ width: RASTER_WIDTH, withoutEnlargement: false })
        .png()
        .toBuffer();
      const pngPath = `${ctx.userId}/${baseName}.png`;
      const { error: pngUploadErr } = await adminClient()
        .storage
        .from(IMAGE_BUCKET)
        .upload(pngPath, pngBuffer, { contentType: "image/png", upsert: false });
      if (pngUploadErr) {
        rasterErr = `png upload failed: ${pngUploadErr.message}`;
      } else {
        pngUrl = `${supabaseUrl}/storage/v1/object/public/${IMAGE_BUCKET}/${pngPath}`;
      }
    } catch (e) {
      rasterErr = `svg→png conversion failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  const title = titleArg ?? `Image ${ts.slice(0, 10)}`;
  const summary = description || "Image stored in vault";
  const docSlug = titleArg ? slugify(titleArg) : ts.slice(0, 10);
  const docPath = pathArg ?? `images/${docSlug}.md`;

  // Doc embeds PNG when we have one (social-safe), with an SVG source
  // link. Falls back to the uploaded original otherwise.
  const embedUrl = pngUrl ?? imageUrl;
  const svgSourceLink = pngUrl ? `\n[SVG source](${imageUrl})\n` : "";
  const docContent = `# ${title}\n\n> ${summary}\n\n![${title}](${embedUrl})\n${svgSourceLink}\n## Notes\n\n`;

  await writeVaultFile(ctx, docPath, docContent);

  return json({
    doc_path: docPath,
    image_url: imageUrl,
    png_url: pngUrl,
    rasterize_error: rasterErr,
    doc_created: true,
  });
}
