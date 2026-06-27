// SPRINT-018 Phase 1+2: backfill doc_edges from vault_files using the
// shared parser + resolver from src/core/. Idempotent — wipes existing
// rows per-namespace before re-inserting so re-running is safe.
//
// Run from project root:
//   npx tsx scripts/backfill-doc-edges.ts              # all namespaces
//   npx tsx scripts/backfill-doc-edges.ts --namespace=user_XXX  # one namespace
//   npx tsx scripts/backfill-doc-edges.ts user_XXX     # positional shorthand
//
// Single-namespace mode is the SPRINT-028 entry point: use it to repair
// a freshly-seeded user whose per-file syncDocEdges races dropped edges.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEdges } from "../src/core/parseEdges";
import { pickByLocality, filenameSlug } from "../src/core/resolveLink";
import { SYSTEM_NODES, systemNodeContent } from "../src/lib/system-nodes";

const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("Missing Supabase env vars (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SECRET_KEY).");

const sb = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

const nsFlag = process.argv.find((a) => a.startsWith("--namespace="))?.slice("--namespace=".length);
const nsPositional = process.argv.slice(2).find((a) => !a.startsWith("--"));
const filterNs: string | null = nsFlag ?? nsPositional ?? null;
if (filterNs) console.log(`Filtering to namespace: ${filterNs}`);

function deriveTitle(rel: string, content: string): string {
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^#\s+(.*?)\s*$/);
    if (m) return m[1].trim();
  }
  const last = rel.split("/").pop() ?? rel;
  return last.replace(/\.md$/i, "");
}

interface EdgeRow {
  namespace: string;
  from_path: string;
  to_path: string;
  kind: "hierarchy" | "assoc";
  label: string | null;
  position: number;
}

console.log("Reading vault_files…");
// Paginate explicitly — Supabase enforces a 1000-row server-side cap that
// .range() lifts but caller still must walk pages. Backfilling a 600+ doc
// namespace without pagination would silently truncate.
const PAGE = 1000;
const allRows: Array<{ namespace: string; file_path: string; content: string }> = [];
let pageStart = 0;
while (true) {
  let q = sb
    .from("vault_files")
    .select("namespace, file_path, content")
    .range(pageStart, pageStart + PAGE - 1);
  if (filterNs) q = q.eq("namespace", filterNs);
  const { data, error: readErr } = await q;
  if (readErr) throw readErr;
  if (!data || data.length === 0) break;
  allRows.push(...(data as Array<{ namespace: string; file_path: string; content: string }>));
  if (data.length < PAGE) break;
  pageStart += PAGE;
}
console.log(`Read ${allRows.length} rows across namespaces.`);

const byNs = new Map<string, Array<{ path: string; content: string }>>();
for (const r of allRows) {
  const arr = byNs.get(r.namespace) ?? [];
  arr.push({ path: r.file_path, content: r.content });
  byNs.set(r.namespace, arr);
}

let totalEdges = 0;
for (const [ns, rawDocs] of byNs) {
  // Inject virtual system nodes so [[EMDEE]] / [[VAULT]] etc. resolve even
  // when those nodes have no stored file in vault_files.
  const presentPaths = new Set(rawDocs.map((d) => d.path));
  const docs = [...rawDocs];
  for (const node of SYSTEM_NODES) {
    if (!presentPaths.has(node.path)) {
      docs.push({ path: node.path, content: systemNodeContent(node) });
    }
  }

  console.log(`\nNamespace ${ns}: ${rawDocs.length} stored docs (+${docs.length - rawDocs.length} virtual)`);

  // Title-or-slug map; same precedence as the indexer.
  const titleMap = new Map<string, string[]>();
  const slugMap = new Map<string, string[]>();
  for (const d of docs) {
    const title = deriveTitle(d.path, d.content).toLowerCase();
    const slug = filenameSlug(d.path).toLowerCase();
    const tArr = titleMap.get(title) ?? [];
    tArr.push(d.path);
    titleMap.set(title, tArr);
    const sArr = slugMap.get(slug) ?? [];
    sArr.push(d.path);
    slugMap.set(slug, sArr);
  }
  const resolve = (t: string, fromPath: string): string | undefined => {
    const lower = t.toLowerCase();
    const titles = titleMap.get(lower);
    if (titles && titles.length > 0) {
      return titles.length === 1 ? titles[0] : pickByLocality(titles.map((path) => ({ path })), fromPath).path;
    }
    const slugs = slugMap.get(lower);
    if (slugs && slugs.length > 0) {
      return slugs.length === 1 ? slugs[0] : pickByLocality(slugs.map((path) => ({ path })), fromPath).path;
    }
    return undefined;
  };

  // Hierarchy: prefer parent_of (authoritative for sibling order). child_of
  // declarations fill in asymmetric stragglers with sentinel position 9999.
  const hierMap = new Map<string, EdgeRow>();
  for (const d of docs) {
    const bullets = parseEdges(d.content);
    let pos = 0;
    for (const b of bullets) {
      if (b.kind !== "parent_of") continue;
      const target = resolve(b.target, d.path);
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
      const target = resolve(b.target, d.path);
      if (!target || target === d.path) continue;
      const key = `${target}::${d.path}`;
      if (hierMap.has(key)) continue;
      hierMap.set(key, {
        namespace: ns,
        from_path: target,
        to_path: d.path,
        kind: "hierarchy",
        label: b.label,
        position: 9999,
      });
    }
  }

  // Associates: deduped per pair; suppress hierarchy-linked or sibling pairs.
  const hierPairs = new Set<string>();
  const parentsOf = new Map<string, Set<string>>();
  for (const r of hierMap.values()) {
    const [lo, hi] = r.from_path < r.to_path ? [r.from_path, r.to_path] : [r.to_path, r.from_path];
    hierPairs.add(`${lo}::${hi}`);
    const set = parentsOf.get(r.to_path) ?? new Set<string>();
    set.add(r.from_path);
    parentsOf.set(r.to_path, set);
  }
  const shareParent = (a: string, b: string) => {
    const pa = parentsOf.get(a);
    const pb = parentsOf.get(b);
    if (!pa || !pb) return false;
    for (const p of pa) if (pb.has(p)) return true;
    return false;
  };

  interface AssocPair { a: string; b: string; label: string | null; position: number; }
  const assocPairs = new Map<string, AssocPair>();
  for (const d of docs) {
    const bullets = parseEdges(d.content);
    let pos = 0;
    for (const b of bullets) {
      if (b.kind !== "associated") continue;
      const target = resolve(b.target, d.path);
      if (!target || target === d.path) continue;
      const [lo, hi] = d.path < target ? [d.path, target] : [target, d.path];
      const key = `${lo}::${hi}`;
      if (hierPairs.has(key)) continue;
      if (shareParent(d.path, target)) continue;
      if (!assocPairs.has(key)) {
        assocPairs.set(key, { a: d.path, b: target, label: b.label, position: pos });
        pos++;
      }
    }
  }

  const edgeRows: EdgeRow[] = [];
  for (const r of hierMap.values()) edgeRows.push(r);
  for (const { a, b, label, position } of assocPairs.values()) {
    edgeRows.push({ namespace: ns, from_path: a, to_path: b, kind: "assoc", label, position });
    edgeRows.push({ namespace: ns, from_path: b, to_path: a, kind: "assoc", label, position });
  }

  console.log(`  → ${hierMap.size} hierarchy edges, ${assocPairs.size} assoc pairs (${edgeRows.length} rows total)`);

  const { error: delErr } = await sb.from("doc_edges").delete().eq("namespace", ns);
  if (delErr) throw delErr;

  for (let i = 0; i < edgeRows.length; i += 500) {
    const chunk = edgeRows.slice(i, i + 500);
    const { error: insErr } = await sb.from("doc_edges").upsert(chunk);
    if (insErr) throw insErr;
  }

  totalEdges += edgeRows.length;
  console.log(`  inserted ${edgeRows.length} rows for ${ns}`);
}

const { count, error: countErr } = await sb
  .from("doc_edges")
  .select("*", { count: "exact", head: true });
if (countErr) throw countErr;

console.log(`\n──────────────────────────────────────`);
console.log(`Done. doc_edges row count: ${count} (expected ${totalEdges})`);
