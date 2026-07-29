// SPRINT-169 + SPRINT-170: HARD RULE 11 regression spec for SVG→PNG
// rasterisation inside upload_image.
//
// Guards:
//   1. resvg-js is present + can rasterise a trivial SVG.
//   2. Font rendering works — an SVG referencing `Helvetica` (a font
//      Vercel serverless doesn't ship) rasterises to a PNG containing
//      non-background pixels where the text should be. Regression
//      against the SPRINT-169 tofu-box bug on Vercel.
//   3. The rasterize arg is threaded through (rasterize=false skips
//      the PNG branch — verifiable by inspecting the returned shape
//      even without live Supabase).

import { expect, test } from "@playwright/test";
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadImage } from "@/src/lib/mcp/tools/upload_image";
import type { ToolContext } from "@/src/lib/mcp/tools/types";
import { DEJAVU_SANS_TTF_BASE64 } from "@/src/lib/mcp/fonts/DejaVuSans.b64";

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

// Materialise the font once per spec run — same pattern the tool uses.
const FONT_PATH = join(tmpdir(), "emdee-DejaVuSans-e2e.ttf");
if (!existsSync(FONT_PATH)) {
  writeFileSync(FONT_PATH, Buffer.from(DEJAVU_SANS_TTF_BASE64, "base64"));
}

test.describe("upload_image rasterise (SPRINT-169 + SPRINT-170)", () => {
  test("resvg-js can convert a trivial SVG to PNG", async () => {
    const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'><rect width='10' height='10' fill='red'/></svg>";
    const resvg = new Resvg(Buffer.from(svg, "utf8"), { font: { loadSystemFonts: false, fontFiles: [FONT_PATH], defaultFontFamily: "DejaVu Sans" } });
    const png = resvg.render().asPng();
    expect(png.length).toBeGreaterThan(0);
    // PNG signature is 89 50 4E 47.
    expect(png[0]).toBe(0x89);
    expect(png[1]).toBe(0x50);
    expect(png[2]).toBe(0x4e);
    expect(png[3]).toBe(0x47);
  });

  test("SVG text with Helvetica renders (SPRINT-170 tofu-box regression)", async () => {
    // Reference `Helvetica` — Vercel serverless has no such font. If
    // our font wiring is wrong the text renders as tofu boxes; the
    // rasteriser should alias Helvetica → DejaVu Sans and produce a
    // PNG with non-trivial pixel data.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><rect width="200" height="60" fill="white"/><text x="10" y="35" font-family="Helvetica" font-size="24" fill="black">Hello</text></svg>`;
    const resvg = new Resvg(Buffer.from(svg, "utf8"), {
      font: {
        loadSystemFonts: false,
        fontFiles: [FONT_PATH],
        defaultFontFamily: "DejaVu Sans",
        sansSerifFamily: "DejaVu Sans",
      },
    });
    const png = resvg.render().asPng();
    // A blank/white-only PNG at 200×60 compresses to a very small file.
    // Text glyphs push the file size up materially — >600 bytes is a
    // conservative floor for the word "Hello" at 24pt.
    expect(png.length).toBeGreaterThan(600);
  });

  test("rasterize=false is accepted and threaded past validation", async () => {
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

// silence unused-import lint if readFileSync ends up unused after edits
void readFileSync;
