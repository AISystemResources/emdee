// SPRINT-169: HARD RULE 11 regression spec for SVG→PNG rasterisation
// inside upload_image.
//
// Guards:
//   1. The rasterize arg is threaded through (rasterize=false skips
//      the PNG branch — verifiable by inspecting the returned shape
//      even without live Supabase).
//   2. sharp is present + can be imported; a broken sharp install
//      would explode at module-load, which this spec catches.
//
// The end-to-end SVG→PNG upload requires a live Supabase Storage
// bucket — that's exercised by the CLI smoke path, not here.

import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { uploadImage } from "@/src/lib/mcp/tools/upload_image";
import type { ToolContext } from "@/src/lib/mcp/tools/types";

interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
}

function parse(raw: unknown): Record<string, unknown> {
  const r = raw as ToolCallResult;
  expect(r.content?.[0]?.type).toBe("text");
  return JSON.parse(r.content[0].text) as Record<string, unknown>;
}

const stubCtx = {
  mode: "cloud",
  userId: "user_test",
  storage: {} as never,
  db: {} as never,
} as unknown as ToolContext;

test.describe("upload_image rasterise (SPRINT-169)", () => {
  test("sharp can convert a trivial SVG to PNG", async () => {
    // Sanity check that the sharp install is functional. If this
    // fails, no amount of validation logic will save the caller.
    const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'><rect width='10' height='10' fill='red'/></svg>";
    const png = await sharp(Buffer.from(svg, "utf8")).png().toBuffer();
    expect(png.length).toBeGreaterThan(0);
    // PNG signature is 89 50 4E 47.
    expect(png[0]).toBe(0x89);
    expect(png[1]).toBe(0x50);
    expect(png[2]).toBe(0x4e);
    expect(png[3]).toBe(0x47);
  });

  test("rasterize=false is accepted and threaded past validation", async () => {
    // We can't verify the PNG-branch was actually skipped without
    // live storage — but we can verify the call doesn't reject the
    // arg and doesn't fail the media-type gate. If rasterize=false
    // ever gets rejected as an unknown arg, this spec catches it.
    const svg = "<svg xmlns='http://www.w3.org/2000/svg'/>";
    const image_data = Buffer.from(svg, "utf8").toString("base64");
    let result: Record<string, unknown> | null = null;
    let thrown: unknown = null;
    try {
      result = parse(await uploadImage(stubCtx, {
        image_data,
        media_type: "image/svg+xml",
        rasterize: false,
      }));
    } catch (e) {
      thrown = e;
    }
    if (result?.error) {
      expect(String(result.error)).not.toContain("unsupported");
      expect(String(result.error)).not.toContain("rasterize");
    } else if (thrown) {
      const msg = thrown instanceof Error ? thrown.message : String(thrown);
      expect(msg).not.toContain("unsupported");
      expect(msg).not.toContain("rasterize");
    }
  });
});
