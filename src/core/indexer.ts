import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export type RelationKind = "hierarchy" | "assoc";
export type Role = "parent" | "child" | "assoc";

/**
 * One bullet under a relationship section. The first wiki-link on the bullet
 * is the declared edge target. Any other wiki-links in the same bullet are
 * captured as `inline` references (navigational hints, not edges).
 */
export interface Link {
  /** Raw target title from the leading wiki-link. */
  title: string;
  /** Trailing prose on the bullet after the leading link, trimmed. May be empty. */
  note: string;
  /** Other wiki-links found in the bullet's prose (excluding the leading one). */
  inline: string[];
}

export interface DocNode {
  path: string;
  title: string;
  content: string;
  /** First blockquote line directly under the H1 (`> ...`), trimmed. May be empty. */
  summary: string;
  /** Parents this doc declares (via `## Child of`). */
  parents: Link[];
  /** Children this doc declares (via `## Parent of`). */
  children: Link[];
  /** Associates this doc declares (via `## Associated with`). */
  associates: Link[];
  /** All wiki-link titles found anywhere in the doc (for derived backlinks). */
  mentions: string[];
}

export interface Edge {
  from: string;
  to: string;
  kind: RelationKind;
}

export interface DocIndex {
  docs: DocNode[];
  edges: Edge[];
  entry: string | null;
}

const WIKI_LINK = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;
const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const BLOCKQUOTE = /^\s*>\s?(.*)$/;

function deriveTitle(rel: string, content: string): string {
  const heading = content.match(/^#\s+(.+)$/m);
  if (heading) return heading[1].trim();
  return path.basename(rel, ".md");
}

const FENCE = /^\s*(?:```|~~~)/;

/** Yields lines that are NOT inside fenced code blocks. */
function* outsideFences(content: string): IterableIterator<string> {
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

function deriveSummary(content: string): string {
  // First blockquote line that appears after the H1, before the next heading.
  let seenH1 = false;
  for (const line of outsideFences(content)) {
    const h = line.match(HEADING);
    if (h) {
      if (!seenH1 && h[1] === "#") {
        seenH1 = true;
        continue;
      }
      if (seenH1) return ""; // hit another heading first — no summary
    }
    if (!seenH1) continue;
    const bq = line.match(BLOCKQUOTE);
    if (bq) return bq[1].trim();
  }
  return "";
}

function classifyHeading(raw: string): Role | null {
  const t = raw.trim().toLowerCase();
  if (t === "parent of") return "child"; // children of this doc
  if (t === "child of") return "parent"; // parents of this doc
  if (t === "associated with" || t === "associated") return "assoc";
  return null;
}

interface BulletParse {
  leading: string;
  note: string;
  inline: string[];
}

function parseBullet(text: string): BulletParse | null {
  const links = [...text.matchAll(WIKI_LINK)];
  if (links.length === 0) return null;
  const first = links[0];
  const leading = first[1].trim();
  const after = text.slice(first.index! + first[0].length);
  // Strip common leading separators between the link and the prose.
  const note = after.replace(/^\s*[—–\-:|·,]\s*/, "").trim();
  const inline = links.slice(1).map((m) => m[1].trim()).filter(Boolean);
  return { leading, note, inline };
}

interface Sections {
  parents: Link[];
  children: Link[];
  associates: Link[];
}

function extractSections(content: string): Sections {
  const out: Sections = { parents: [], children: [], associates: [] };
  let role: Role | null = null;
  for (const line of outsideFences(content)) {
    const h = line.match(HEADING);
    if (h) {
      role = classifyHeading(h[2]);
      continue;
    }
    if (!role) continue;
    const b = line.match(BULLET);
    if (!b) continue;
    const parsed = parseBullet(b[1]);
    if (!parsed) continue;
    const link: Link = { title: parsed.leading, note: parsed.note, inline: parsed.inline };
    if (role === "parent") out.parents.push(link);
    else if (role === "child") out.children.push(link);
    else out.associates.push(link);
  }
  return out;
}

function extractAllMentions(content: string): string[] {
  const seen = new Set<string>();
  for (const line of outsideFences(content)) {
    for (const m of line.matchAll(WIKI_LINK)) {
      const t = m[1].trim();
      if (t) seen.add(t);
    }
  }
  return [...seen];
}

async function walk(dir: string, base: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full, base)));
    else if (e.isFile() && e.name.endsWith(".md")) out.push(path.relative(base, full));
  }
  return out;
}

export async function buildIndex(docsDir: string): Promise<DocIndex> {
  try {
    await stat(docsDir);
  } catch {
    return { docs: [], edges: [], entry: null };
  }

  const files = await walk(docsDir, docsDir);
  const docs: DocNode[] = [];
  for (const rel of files) {
    const content = await readFile(path.join(docsDir, rel), "utf8");
    const sections = extractSections(content);
    docs.push({
      path: rel,
      title: deriveTitle(rel, content),
      content,
      summary: deriveSummary(content),
      parents: dedupeLinks(sections.parents),
      children: dedupeLinks(sections.children),
      associates: dedupeLinks(sections.associates),
      mentions: extractAllMentions(content),
    });
  }

  const titleToPath = new Map<string, string>();
  for (const d of docs) titleToPath.set(d.title.toLowerCase(), d.path);

  const seen = new Set<string>();
  const edges: Edge[] = [];
  const pushHier = (parentPath: string, childPath: string) => {
    if (parentPath === childPath) return;
    const key = `H:${parentPath}->${childPath}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from: parentPath, to: childPath, kind: "hierarchy" });
  };
  const pushAssoc = (a: string, b: string) => {
    if (a === b) return;
    const [x, y] = a < b ? [a, b] : [b, a];
    const key = `A:${x}::${y}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from: x, to: y, kind: "assoc" });
  };

  for (const d of docs) {
    for (const link of d.children) {
      const childPath = titleToPath.get(link.title.toLowerCase());
      if (childPath) pushHier(d.path, childPath);
    }
    for (const link of d.parents) {
      const parentPath = titleToPath.get(link.title.toLowerCase());
      if (parentPath) pushHier(parentPath, d.path);
    }
    for (const link of d.associates) {
      const assocPath = titleToPath.get(link.title.toLowerCase());
      if (assocPath) pushAssoc(d.path, assocPath);
    }
  }

  // Entry point: canonical is mane.md. Override with EMDEE_ENTRY env var
  // if a user wants a different filename. No silent fallback — if neither is
  // present, entry is null and the UI surfaces "no entry doc".
  const overrideEntry = process.env.EMDEE_ENTRY?.toLowerCase();
  const entry =
    (overrideEntry
      ? docs.find((d) => d.path.toLowerCase() === overrideEntry)?.path
      : undefined) ??
    docs.find((d) => d.path.toLowerCase() === "emdee.md")?.path ??
    null;

  return { docs, edges, entry };
}

function dedupeLinks(links: Link[]): Link[] {
  const out: Link[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    const key = link.title.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(link);
  }
  return out;
}
