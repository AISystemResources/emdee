// SPRINT-018 Phase 1: backfill doc_edges from vault_files.
//
// Reads every doc from the vault_files cache, parses `## Parent of` /
// `## Child of` / `## Associated with` bullets, resolves wiki-link
// targets to actual file paths via the same title-or-slug map the
// indexer uses, and writes rows to doc_edges. Idempotent — wipes
// existing rows per-namespace before re-inserting so re-running is
// safe.
//
// Run from project root: node scripts/backfill-doc-edges.mjs
//
// NOTE: the bullet parser here mirrors src/core/parseEdges.ts (when
// SPRINT-018 Phase 2 lands). Keep them in sync if either changes.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("Missing Supabase env vars (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SECRET_KEY).");

const sb = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

// --- bullet parser (mirror of src/core/parseEdges.ts) ---------------

const HEADING = /^(#{1,6})\s+(.*?)\s*$/;
const BULLET = /^\s*[*+\-]\s+(.*?)\s*$/;
const WIKI_LINK = /\[\[([^\]]+)\]\]/g;
const FENCE = /^(```|~~~)/;

function* outsideFences(content) {
  let inFence = false;
  for (const line of content.split(/\r?\n/)) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    yield line;
  }
}

function classifyHeading(raw) {
  const t = raw.trim().toLowerCase();
  if (t === "parent of") return "parent_of";
  if (t === "child of") return "child_of";
  if (t === "associated with" || t === "associated") return "associated";
  return null;
}

function parseBullet(text) {
  const links = [...text.matchAll(WIKI_LINK)];
  if (links.length === 0) return null;
  const first = links[0];
  const leading = first[1].trim();
  const after = text.slice(first.index + first[0].length);
  const label = after.replace(/^\s*[—–\-:|·,]\s*/, "").trim();
  return { leading, label: label || null };
}

function parseEdges(content) {
  const out = [];
  let kind = null;
  let pos = 0;
  for (const line of outsideFences(content)) {
    const h = line.match(HEADING);
    if (h) {
      kind = classifyHeading(h[2]);
      pos = 0;
      continue;
    }
    if (!kind) continue;
    const b = line.match(BULLET);
    if (!b) continue;
    const parsed = parseBullet(b[1]);
    if (!parsed) continue;
    out.push({ kind, target: parsed.leading, label: parsed.label, position: pos });
    pos++;
  }
  return out;
}

function deriveTitle(rel, content) {
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^#\s+(.*?)\s*$/);
    if (m) return m[1].trim();
  }
  const last = rel.split("/").pop() ?? rel;
  return last.replace(/\.md$/i, "");
}

function filenameSlug(p) {
  const last = p.split("/").pop() ?? p;
  return last.replace(/\.md$/i, "").toLowerCase();
}

// --- main -----------------------------------------------------------

console.log("Reading vault_files…");
const { data: rows, error: readErr } = await sb
  .from("vault_files")
  .select("namespace, file_path, content");
if (readErr) throw readErr;
console.log(`Read ${rows.length} rows across namespaces.`);

const byNs = new Map();
for (const r of rows) {
  const arr = byNs.get(r.namespace) ?? [];
  arr.push({ path: r.file_path, content: r.content });
  byNs.set(r.namespace, arr);
}

let totalEdges = 0;
for (const [ns, docs] of byNs) {
  console.log(`\nNamespace ${ns}: ${docs.length} docs`);

  // Title-or-slug resolution map. Title is the doc's H1 (lowercased);
  // slug is the filename without `.md` (lowercased). Title takes
  // precedence — same priority order as the indexer.
  const titleMap = new Map();
  const slugMap = new Map();
  for (const d of docs) {
    const title = deriveTitle(d.path, d.content).toLowerCase();
    const slug = filenameSlug(d.path);
    if (!titleMap.has(title)) titleMap.set(title, d.path);
    if (!slugMap.has(slug)) slugMap.set(slug, d.path);
  }
  const resolve = (t) => {
    const lower = t.toLowerCase();
    return titleMap.get(lower) ?? slugMap.get(lower);
  };

  // Hierarchy: prefer parent_of declarations (authoritative for sibling
  // order). child_of declarations fill in gaps with a sentinel position
  // so asymmetric stragglers sort after declared siblings.
  const hierMap = new Map(); // "from::to" -> row
  for (const d of docs) {
    const bullets = parseEdges(d.content);
    let pos = 0;
    for (const b of bullets) {
      if (b.kind !== "parent_of") continue;
      const target = resolve(b.target);
      if (!target || target === d.path) continue;
      hierMap.set(`${d.path}::${target}`, {
        namespace: ns,
        from_path: d.path,
        to_path: target,
        kind: "hierarchy",
        label: b.label,
        position: pos++,
      });
    }
  }
  for (const d of docs) {
    const bullets = parseEdges(d.content);
    for (const b of bullets) {
      if (b.kind !== "child_of") continue;
      const target = resolve(b.target);
      if (!target || target === d.path) continue;
      const key = `${target}::${d.path}`;
      if (hierMap.has(key)) continue;
      hierMap.set(key, {
        namespace: ns,
        from_path: target,
        to_path: d.path,
        kind: "hierarchy",
        label: b.label,
        position: 9999, // tail — asymmetric straggler
      });
    }
  }

  // Associates: two rows per declaration. Dedupe so an A->B declaration
  // on either side produces exactly one pair (two rows total).
  const assocMap = new Map(); // "min::max" -> { a, b, label, position }
  for (const d of docs) {
    const bullets = parseEdges(d.content);
    let pos = 0;
    for (const b of bullets) {
      if (b.kind !== "associated") continue;
      const target = resolve(b.target);
      if (!target || target === d.path) continue;
      const [lo, hi] = d.path < target ? [d.path, target] : [target, d.path];
      const key = `${lo}::${hi}`;
      if (!assocMap.has(key)) {
        assocMap.set(key, { a: d.path, b: target, label: b.label, position: pos });
        pos++;
      }
    }
  }

  const edgeRows = [];
  for (const r of hierMap.values()) edgeRows.push(r);
  for (const { a, b, label, position } of assocMap.values()) {
    edgeRows.push({ namespace: ns, from_path: a, to_path: b, kind: "assoc", label, position });
    edgeRows.push({ namespace: ns, from_path: b, to_path: a, kind: "assoc", label, position });
  }

  console.log(`  → ${hierMap.size} hierarchy edges, ${assocMap.size} assoc pairs (${edgeRows.length} rows total)`);

  const { error: delErr } = await sb.from("doc_edges").delete().eq("namespace", ns);
  if (delErr) throw delErr;

  for (let i = 0; i < edgeRows.length; i += 500) {
    const chunk = edgeRows.slice(i, i + 500);
    const { error: insErr } = await sb.from("doc_edges").upsert(chunk);
    if (insErr) throw insErr;
  }

  totalEdges += edgeRows.length;
  console.log(`  ✓ inserted ${edgeRows.length} rows for ${ns}`);
}

const { count, error: countErr } = await sb
  .from("doc_edges")
  .select("*", { count: "exact", head: true });
if (countErr) throw countErr;

console.log(`\n──────────────────────────────────────`);
console.log(`Done. doc_edges row count: ${count} (expected ${totalEdges})`);
