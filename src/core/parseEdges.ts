// SPRINT-018 Phase 2: shared bullet parser for `## Parent of` /
// `## Child of` / `## Associated with` sections. Returns a flat list of
// ParsedEdge — the caller (syncDocEdges, backfill) resolves targets and
// applies suppression.
//
// Kept dumb on purpose: no resolver, no de-dup, no cross-doc awareness.
// Mirrors the indexer's parsing rules (outside fences only, leading
// wiki-link wins, optional dash/colon between link and label prose).

export type ParsedEdgeKind = "parent_of" | "child_of" | "associated";

export interface ParsedEdge {
  kind: ParsedEdgeKind;
  /** Raw target title from the leading wiki-link (untrimmed of case). */
  target: string;
  /** Trailing prose on the bullet after the leading link, trimmed. May be null. */
  label: string | null;
  /** 0-based index within this section (resets per section). */
  position: number;
}

const HEADING = /^(#{1,6})\s+(.*?)\s*$/;
const BULLET = /^\s*[*+\-]\s+(.*?)\s*$/;
const WIKI_LINK = /\[\[([^\]]+)\]\]/g;
const FENCE = /^(```|~~~)/;

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

function classifyHeading(raw: string): ParsedEdgeKind | null {
  const t = raw.trim().toLowerCase();
  if (t === "parent of") return "parent_of";
  if (t === "child of") return "child_of";
  if (t === "associated with" || t === "associated") return "associated";
  return null;
}

interface BulletParse {
  leading: string;
  label: string | null;
}

function parseBullet(text: string): BulletParse | null {
  const links = [...text.matchAll(WIKI_LINK)];
  if (links.length === 0) return null;
  const first = links[0];
  const leading = first[1].trim();
  if (!leading) return null;
  const after = text.slice((first.index ?? 0) + first[0].length);
  // Strip common leading separators between the link and the prose.
  const label = after.replace(/^\s*[—–\-:|·,]\s*/, "").trim();
  return { leading, label: label || null };
}

/**
 * Flat-parse a doc body into the edge declarations it makes. Position is
 * reset per relationship section so the caller can preserve sibling
 * ordering off `parent_of` bullets.
 */
export function parseEdges(content: string): ParsedEdge[] {
  const out: ParsedEdge[] = [];
  let kind: ParsedEdgeKind | null = null;
  // Heading level at which `kind` was set. A deeper sub-heading (e.g.
  // `### Vocabulary & units` inside `## Parent of`) does NOT exit the
  // relation section — bullets under the sub-heading still count.
  // Only an equal-or-shallower heading exits the section.
  let kindLevel = 0;
  let pos = 0;
  for (const line of outsideFences(content)) {
    const h = line.match(HEADING);
    if (h) {
      const level = h[1].length;
      const classified = classifyHeading(h[2]);
      if (classified) {
        kind = classified;
        kindLevel = level;
        pos = 0;
      } else if (level <= kindLevel) {
        // Sibling-or-shallower heading exits the relation section.
        kind = null;
        kindLevel = 0;
        pos = 0;
      }
      // Otherwise (deeper heading inside relation section): keep `kind`
      // and `pos` so bullets under sub-headings continue to accrue.
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
