import type { DocIndex, DocNode } from "./indexer";

/**
 * Resolve a wiki-link target to a doc in the given index. Tries the H1
 * title first (case-insensitive); falls back to the filename slug (last
 * path segment without ".md"). The filename fallback handles vaults
 * where wiki-links use the SCREAMING-KEBAB form while H1s carry a
 * human-friendly title.
 *
 * When two docs share the same title or slug (e.g. an SFPDI/DAY1 and a
 * GBI/DAY1), `fromPath` disambiguates by locality — a link from
 * `events/seminars/SFPDI.md` to `[[DAY1]]` picks the candidate sitting
 * under `events/seminars/SFPDI/`, not its GBI cousin. Without
 * `fromPath` we fall back to first-match (legacy behaviour).
 */
export function resolveWikiLink(index: DocIndex, target: string, fromPath?: string): DocNode | null {
  const t = target.trim().toLowerCase();
  if (!t) return null;
  const titleMatches = index.docs.filter((d) => d.title.toLowerCase() === t);
  if (titleMatches.length === 1) return titleMatches[0];
  if (titleMatches.length > 1) return pickByLocality(titleMatches, fromPath);
  const slugMatches = index.docs.filter((d) => filenameSlug(d.path).toLowerCase() === t);
  if (slugMatches.length === 1) return slugMatches[0];
  if (slugMatches.length > 1) return pickByLocality(slugMatches, fromPath);
  return null;
}

/** Last path segment with ".md" stripped. "events/foo/BAR.md" → "BAR". */
export function filenameSlug(path: string): string {
  const last = path.split("/").pop() ?? path;
  return last.replace(/\.md$/i, "");
}

/**
 * Build a set of lowercase keys (H1 titles + filename slugs) that
 * resolve to in-set docs. Used by rewriteForPublic to decide whether a
 * wiki-link should remain navigable or be flattened to plain text.
 */
export function resolvableKeysLower(docs: DocNode[]): Set<string> {
  const out = new Set<string>();
  for (const d of docs) {
    out.add(d.title.toLowerCase());
    out.add(filenameSlug(d.path).toLowerCase());
  }
  return out;
}

/**
 * Tiered locality scoring for an ambiguous wiki-link. Higher tier wins;
 * within a tier, shorter shared prefix loses (i.e. more shared segments
 * is better). Falls back to first candidate if `fromPath` is missing.
 *
 * SPRINT-060 (SIG-007 part B): before locality scoring, candidates are
 * filtered by **namespace family** to prevent shared content shadowing
 * own content (and vice versa). The namespace family of a path:
 *   - `__shared:<ownerId>:<rest>` → shared, scoped to that ownerId
 *   - any other path                → own
 * A wiki-link from an own doc only resolves to own candidates when an
 * own candidate exists; from a shared doc by owner X only to candidates
 * also shared by X. If no same-family candidate exists, fall through to
 * the cross-family pool (preserves prior behaviour for single-match
 * shared docs linked from own context).
 *
 * Tiers (from `fromPath`'s point of view):
 *   5 — same directory as the linking doc (sibling)
 *   4 — descendant of "fromPath as a folder" (matches the common pattern
 *       where `SFPDI.md` indexes a sibling `SFPDI/` directory)
 *   3 — ancestor directory of the linking doc (linking up the tree)
 *   2 — shares any leading path segments
 *   1 — no overlap; first match wins
 */
const SHARED_PATH_RE = /^__shared:([^:]+):/;

function namespaceFamily(path: string): { kind: "shared"; ownerId: string } | { kind: "own" } {
  const m = path.match(SHARED_PATH_RE);
  if (m) return { kind: "shared", ownerId: m[1] };
  return { kind: "own" };
}

function sameFamily(a: string, b: string): boolean {
  const fa = namespaceFamily(a);
  const fb = namespaceFamily(b);
  if (fa.kind !== fb.kind) return false;
  if (fa.kind === "shared" && fb.kind === "shared") return fa.ownerId === fb.ownerId;
  return true;
}

export function pickByLocality<T extends { path: string }>(candidates: T[], fromPath?: string): T {
  if (!fromPath || candidates.length === 0) return candidates[0];

  // Namespace-family filter: if any candidate shares the linking doc's
  // namespace family, restrict to those. Prevents own/shared shadowing
  // when both have docs with the same title.
  const sameFamilyCandidates = candidates.filter((c) => sameFamily(c.path, fromPath));
  const effective = sameFamilyCandidates.length > 0 ? sameFamilyCandidates : candidates;

  const fromSegs = fromPath.split("/");
  const fromDir = fromSegs.slice(0, -1);
  const fromBase = (fromSegs[fromSegs.length - 1] ?? "").replace(/\.md$/i, "");

  let best = effective[0];
  let bestScore = -1;
  for (const c of effective) {
    const cSegs = c.path.split("/");
    const cDir = cSegs.slice(0, -1);
    const shared = sharedPrefix(fromDir, cDir);

    let tier = 1;
    if (eqSegs(cDir, fromDir)) tier = 5;
    else if (cDir.length > fromDir.length && eqSegs(cDir.slice(0, fromDir.length), fromDir) && cDir[fromDir.length] === fromBase) tier = 4;
    else if (fromDir.length > cDir.length && eqSegs(fromDir.slice(0, cDir.length), cDir)) tier = 3;
    else if (shared > 0) tier = 2;

    // Score = tier * 1000 + shared-prefix-depth. Lets a tier-2 candidate
    // with 4 shared segments beat a tier-2 with 2 shared segments.
    const score = tier * 1000 + shared;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

function eqSegs(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sharedPrefix(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}
