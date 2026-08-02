// SPRINT-168: HARD RULE 11 regression spec for upload_image's expanded
// media type surface. Prior to this sprint, only raster types were
// accepted (jpg/png/gif/webp), which prevented Claude Code agents from
// uploading generated diagrams (SVG is the only vector format they can
// produce reliably). This spec pins:
//
// 1. SVG is now in the accepted list (image/svg+xml)
// 2. Unsupported types still get a clear error listing all supported
//    types (regression-guards accidentally dropping a type)
// 3. Empty base64 still rejected
//
// The happy-path upload against a live Supabase bucket is exercised by
// the CLI's manual smoke: `emdee upload-image --file /tmp/x.svg --remote`.
// That needs SUPABASE_TEST_URL + a working storage bucket which is
// covered separately.

import { expect, test } from "@playwright/test";
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

// A minimal ToolContext stub — the code path we exercise doesn't touch
// storage / db / userId for the media_type validation branch we're
// testing, but we still need the shape.
const stubCtx = {
  mode: "cloud",
  userId: "user_test",
  storage: {} as never,
  db: {} as never,
  scope: "mcp",
} as unknown as ToolContext;

test.describe("upload_image (SPRINT-168)", () => {
  test("rejects unknown media_type with a list of supported types", async () => {
    const result = parse(await uploadImage(stubCtx, {
      image_data: "AAAA",
      media_type: "image/tiff",
    }));
    expect(result.error).toContain("unsupported media_type");
    // The message must list all 5 supported types so callers can see
    // what to switch to.
    const msg = String(result.error);
    expect(msg).toContain("image/jpeg");
    expect(msg).toContain("image/png");
    expect(msg).toContain("image/gif");
    expect(msg).toContain("image/webp");
    expect(msg).toContain("image/svg+xml");
  });

  test("SVG media type passes the type-validation gate", async () => {
    // The SVG type is accepted at the validation branch. Downstream
    // storage upload needs real Supabase env (SUPABASE_URL) which the
    // test env may not have — so we run the call and accept either:
    //   1. A returned error that is NOT "unsupported media_type", OR
    //   2. A thrown error at adminClient() init (missing env).
    // Both prove SVG made it PAST the type-validation gate, which is
    // the regression we're guarding.
    const svg = "<svg xmlns='http://www.w3.org/2000/svg'/>";
    const image_data = Buffer.from(svg, "utf8").toString("base64");
    let result: Record<string, unknown> | null = null;
    let thrown: unknown = null;
    try {
      result = parse(await uploadImage(stubCtx, { image_data, media_type: "image/svg+xml" }));
    } catch (e) {
      thrown = e;
    }
    if (result) {
      // Any returned error must not be the media_type one.
      if (result.error) {
        expect(String(result.error)).not.toContain("unsupported media_type");
      }
    } else {
      // Thrown at storage/admin init — fine, that's past validation.
      expect(thrown).toBeTruthy();
      const msg = thrown instanceof Error ? thrown.message : String(thrown);
      expect(msg).not.toContain("unsupported media_type");
    }
  });

  test("empty image_data rejected regardless of media type", async () => {
    const result = parse(await uploadImage(stubCtx, {
      image_data: "",
      media_type: "image/svg+xml",
    }));
    expect(result.error).toBe("image_data is required");
  });

  test("local mode refuses upload_image with a clear error", async () => {
    const localCtx = { ...stubCtx, mode: "local" } as ToolContext;
    const result = parse(await uploadImage(localCtx, {
      image_data: "AAAA",
      media_type: "image/svg+xml",
    }));
    expect(String(result.error)).toContain("cloud mode");
  });
});
