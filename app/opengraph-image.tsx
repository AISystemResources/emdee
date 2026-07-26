import { ImageResponse } from "next/og";

// SPRINT-150c: dynamically-rendered OG image for social sharing.
// Next.js resolves this file at /opengraph-image so metadata.openGraph
// automatically points to it. Rendered at request time (edge) so we
// don't have to check in a PNG artifact.
//
// Design: mini-hero — brand mark top-left, giant Fraunces italic "Second
// Brain" phrase in Cerebral Pink, muted supporting line. Matches the
// homepage tone so link previews feel consonant with the destination.

export const runtime = "edge";
export const alt = "EMDEE — Your Second Brain, for you and your AI";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Note: next/og's ImageResponse uses Satori under the hood, which supports
// a subset of CSS. Fraunces is fetched from Google Fonts as a font arrayBuffer
// so the italic renders correctly (default system fonts don't have it).
export default async function OG() {
  const fraunces = await fetch(
    "https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@1,144,400&display=swap",
  )
    .then((res) => res.text())
    .then((css) => {
      const url = css.match(/url\((.+?)\) format/)?.[1];
      if (!url) return null;
      return fetch(url).then((r) => r.arrayBuffer());
    })
    .catch(() => null);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 80px",
          background: "#FFF6F8",
          color: "#1A0E15",
        }}
      >
        {/* Brand mark row */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              padding: "10px 18px",
              border: "2px solid #1A0E15",
              borderRadius: 6,
              fontSize: 24,
              fontFamily: "monospace",
              letterSpacing: "3.5px",
              fontWeight: 600,
            }}
          >
            EMDEE
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              fontFamily: "monospace",
              fontSize: 22,
              color: "#8B0033",
              letterSpacing: "2px",
            }}
          >
            <span style={{ display: "flex", width: 32, height: 2, background: "#8B0033" }} />
            FRONTAL LOBE
          </div>
        </div>

        {/* Hero copy — Fraunces italic if the font loaded, else fallback */}
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              fontSize: 128,
              lineHeight: 1.05,
              letterSpacing: "-2px",
              fontFamily: fraunces ? "Fraunces" : "serif",
              fontStyle: "italic",
              fontWeight: 400,
            }}
          >
            <span style={{ color: "#1A0E15", fontStyle: "normal" }}>Your&nbsp;</span>
            <span style={{ color: "#FF3D6E" }}>Second Brain,</span>
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 128,
              lineHeight: 1.05,
              letterSpacing: "-2px",
              fontFamily: fraunces ? "Fraunces" : "serif",
              color: "#1A0E15",
            }}
          >
            for you and your AI.
          </div>
        </div>

        {/* Supporting line */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontFamily: "sans-serif",
            fontSize: 24,
            color: "#7A6871",
            width: "100%",
          }}
        >
          <span>Local-first · Markdown · MCP-native · Free forever for local use</span>
          <span style={{ color: "#8B0033", fontFamily: "monospace", fontSize: 22 }}>emdee.tech</span>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: fraunces
        ? [{ name: "Fraunces", data: fraunces, style: "italic", weight: 400 }]
        : undefined,
    },
  );
}
