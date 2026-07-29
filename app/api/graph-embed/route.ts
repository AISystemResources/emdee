// SPRINT-172: signed-URL graph embed for Claude.ai Artifact rendering.
//
// Flow:
//   1. get_neighbors returns { interactive_graph_url } with HMAC-signed
//      params (ns, path, exp).
//   2. Claude wraps the URL in a minimal <iframe> artifact.
//   3. This endpoint verifies the signature, loads the doc + neighbours
//      via the same VaultStorage the MCP uses, and serves a
//      self-contained Cytoscape.js HTML page.
//
// Security:
// - Unguessable — HMAC-SHA256 over {ns, path, exp} with GRAPH_EMBED_SECRET.
// - Time-limited — signature expires in 1h by default.
// - Blast radius on leak — titles + summaries of one doc's 1-hop
//   neighbourhood. No doc bodies, no vault dump.

import { SupabaseStorage } from "@/src/lib/storage/SupabaseStorage";
import { cloudDatabase } from "@/src/lib/database";
import { loadVaultIndex } from "@/src/lib/mcp/tools/vault";
import type { ToolContext } from "@/src/lib/mcp/tools/types";
import { resolveWikiLink } from "@/src/core/resolveLink";
import { verifyGraphEmbed } from "@/src/lib/graphEmbedKey";

export const dynamic = "force-dynamic";

interface EgoNode { id: string; label: string; kind: "focal" | "parent" | "child" | "associated"; summary: string }
interface EgoEdge { source: string; target: string; label: string }

async function buildEgoGraph(ns: string, focalPath: string): Promise<{ nodes: EgoNode[]; edges: EgoEdge[]; focal: { title: string; summary: string } } | null> {
  const storage = new SupabaseStorage();
  const ctx: ToolContext = { mode: "cloud", storage, userId: ns, db: cloudDatabase() };
  const idx = await loadVaultIndex(ctx);
  const focal = idx.docs.find((d) => d.path === focalPath);
  if (!focal) return null;

  const byPath = new Map(idx.docs.map((d) => [d.path, d]));
  const resolve = (t: string) => byPath.get(t) ?? resolveWikiLink(idx, t, focal.path);

  const nodes: EgoNode[] = [{ id: focal.path, label: focal.title, kind: "focal", summary: focal.summary }];
  const edges: EgoEdge[] = [];
  const seen = new Set<string>([focal.path]);

  for (const l of focal.parents) {
    const n = resolve(l.title);
    if (!n || seen.has(n.path)) continue;
    seen.add(n.path);
    nodes.push({ id: n.path, label: n.title, kind: "parent", summary: n.summary });
    edges.push({ source: focal.path, target: n.path, label: "child of" });
  }
  for (const l of focal.children) {
    const n = resolve(l.title);
    if (!n || seen.has(n.path)) continue;
    seen.add(n.path);
    nodes.push({ id: n.path, label: n.title, kind: "child", summary: n.summary });
    edges.push({ source: focal.path, target: n.path, label: "parent of" });
  }
  for (const l of focal.associates) {
    const n = resolve(l.title);
    if (!n || seen.has(n.path)) continue;
    seen.add(n.path);
    nodes.push({ id: n.path, label: n.title, kind: "associated", summary: n.summary });
    edges.push({ source: focal.path, target: n.path, label: "associated" });
  }

  return { nodes, edges, focal: { title: focal.title, summary: focal.summary } };
}

function renderHtml(focalTitle: string, elements: string): string {
  // Escape any single-quotes / script-close tags in the JSON payload.
  const safe = elements.replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${focalTitle} — EMDEE ego graph</title>
<style>
  :root {
    --bg: #FFF6F8; --panel: #FFFDFE; --border: #F3D5DD; --fg: #1A0E15;
    --muted: #7A6871; --accent: #FF3D6E; --accent-soft: #FFECEF;
    --deep: #8B0033; --ink: #4D2937;
    --font: "Inter", system-ui, -apple-system, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; font-family: var(--font); background: var(--bg); color: var(--fg); }
  #app { display: flex; flex-direction: column; height: 100vh; }
  header { padding: 12px 16px; border-bottom: 1px solid var(--border); background: var(--panel); }
  header h1 { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase; color: var(--deep); }
  #cy { flex: 1; background: var(--bg); }
  #tip { position: absolute; bottom: 12px; left: 12px; right: 12px; padding: 10px 12px; background: var(--panel); border: 1px solid var(--border); border-radius: 6px; font-size: 12px; color: var(--ink); box-shadow: 0 2px 8px rgba(0,0,0,0.04); pointer-events: none; opacity: 0; transition: opacity 120ms; max-width: 500px; margin: auto; }
  #tip[data-show="1"] { opacity: 1; }
  #tip strong { color: var(--deep); display: block; margin-bottom: 4px; font-size: 13px; }
  footer { padding: 6px 16px; border-top: 1px solid var(--border); background: var(--panel); font-size: 11px; color: var(--muted); }
</style>
</head>
<body>
<div id="app">
  <header><h1>${focalTitle}</h1></header>
  <div id="cy"></div>
  <div id="tip"></div>
  <footer>EMDEE ego graph · hover a node for its summary · click focal to recenter</footer>
</div>
<script src="https://cdn.jsdelivr.net/npm/cytoscape@3.30.2/dist/cytoscape.min.js"></script>
<script>
  const elements = ${safe};
  const cy = cytoscape({
    container: document.getElementById('cy'),
    elements,
    layout: { name: 'concentric', minNodeSpacing: 60, concentric: n => n.data('kind') === 'focal' ? 10 : 1 },
    style: [
      { selector: 'node', style: {
        'label': 'data(label)', 'font-family': 'Inter, sans-serif', 'font-size': 11,
        'color': '#4D2937', 'text-valign': 'bottom', 'text-margin-y': 6,
        'text-wrap': 'wrap', 'text-max-width': 120,
        'background-color': '#FFFDFE', 'border-color': '#F3D5DD', 'border-width': 1.5,
        'width': 36, 'height': 36,
      }},
      { selector: 'node[kind = "focal"]', style: { 'background-color': '#FF3D6E', 'border-color': '#8B0033', 'border-width': 2, 'width': 56, 'height': 56, 'color': '#8B0033', 'font-weight': 700 }},
      { selector: 'node[kind = "parent"]', style: { 'background-color': '#FFECEF', 'border-color': '#FF3D6E' }},
      { selector: 'node[kind = "child"]', style: { 'background-color': '#FFFDFE', 'border-color': '#8B0033' }},
      { selector: 'node[kind = "associated"]', style: { 'background-color': '#FFFDFE', 'border-color': '#7A6871', 'border-style': 'dashed' }},
      { selector: 'edge', style: {
        'width': 1.2, 'line-color': '#F3D5DD', 'target-arrow-color': '#F3D5DD',
        'target-arrow-shape': 'triangle', 'curve-style': 'bezier',
        'label': 'data(label)', 'font-size': 9, 'color': '#7A6871', 'text-rotation': 'autorotate',
        'text-background-color': '#FFF6F8', 'text-background-opacity': 1, 'text-background-padding': 2,
      }},
    ],
    minZoom: 0.4, maxZoom: 2.5, wheelSensitivity: 0.3,
  });
  const tip = document.getElementById('tip');
  cy.on('mouseover', 'node', evt => {
    const n = evt.target;
    const s = n.data('summary') || '';
    tip.innerHTML = '<strong>' + n.data('label') + '</strong>' + (s ? s : '<em style="color:#7A6871">no summary</em>');
    tip.setAttribute('data-show', '1');
  });
  cy.on('mouseout', 'node', () => tip.setAttribute('data-show', '0'));
  cy.on('tap', 'node[kind = "focal"]', () => cy.fit(undefined, 30));
  cy.fit(undefined, 30);
</script>
</body>
</html>`;
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const ns = url.searchParams.get("ns") ?? "";
  const path = url.searchParams.get("path") ?? "";
  const expStr = url.searchParams.get("exp") ?? "";
  const sig = url.searchParams.get("sig") ?? "";
  if (!ns || !path || !expStr || !sig) {
    return new Response("missing params", { status: 400 });
  }
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
    return new Response("link expired", { status: 410 });
  }
  if (!verifyGraphEmbed(ns, path, exp, sig)) {
    return new Response("invalid signature", { status: 403 });
  }
  const ego = await buildEgoGraph(ns, path);
  if (!ego) return new Response("doc not found", { status: 404 });

  const elements = [
    ...ego.nodes.map((n) => ({ data: n })),
    ...ego.edges.map((e) => ({ data: e })),
  ];

  const html = renderHtml(ego.focal.title, JSON.stringify(elements));
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // CDN-cacheable for 1h — same as signature TTL. Signature is part
      // of the URL so cache key naturally includes it → no cross-user
      // bleed even on shared CDNs.
      "cache-control": "public, max-age=3600, s-maxage=3600",
      // Iframe from anywhere (claude.ai etc). Without this Chrome blocks
      // the iframe.
      "x-frame-options": "ALLOWALL",
      "content-security-policy": "frame-ancestors *",
    },
  });
}
