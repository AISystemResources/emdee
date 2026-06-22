// SPRINT-055 (SIG-004): filename casing enforcement helpers.
//
// EMDEE's on-disk filenames are all-caps (e.g. CLAUDE.md, SPRINT-029.md). The
// H1 display title is free-form; wiki-links are case-insensitive so titles
// don't break links no matter their case. Filenames are the durable identifier
// — judgment-free to constrain, lintable, prevents typo-driven duplicates
// (Foo.md vs FOO.md vs foo.md as three different files).

import path from "node:path";

// Allowed in a normalised filename: ASCII uppercase letters, digits, dot,
// hyphen, underscore. Dot is allowed for sub-extensions like FOO.test.md;
// the final `.md` is asserted separately.
const UPPERCASE_BASENAME_RE = /^[A-Z0-9._-]+\.md$/;

export function isUppercaseFilename(filepath: string): boolean {
  const base = path.basename(filepath);
  return UPPERCASE_BASENAME_RE.test(base);
}

/**
 * Normalise a single filename component (no directory) to the project's
 * canonical shape: uppercase, spaces → hyphens, ASCII-only, collapse repeated
 * hyphens. Strips a trailing `.md` if the caller passed one; appends a fresh
 * `.md` always.
 *
 * Used by create_child + image upload code paths where filename derivation
 * is driven by a title/slug rather than a literal user-provided path.
 */
export function normalizeBasename(input: string): string {
  // Strip optional trailing `.md` (case-insensitive) so it doesn't get
  // double-uppercased and we re-append exactly one.
  const stripped = input.replace(/\.md$/i, "");
  const upper = stripped
    .toUpperCase()
    // Whitespace → hyphen
    .replace(/\s+/g, "-")
    // Anything not [A-Z0-9._-] → drop
    .replace(/[^A-Z0-9._-]/g, "")
    // Collapse runs of hyphens
    .replace(/-+/g, "-")
    // Strip leading/trailing hyphens or dots
    .replace(/^[-.]+|[-.]+$/g, "");
  // Fall back to "DOC" if the input was all-non-ASCII.
  const safe = upper || "DOC";
  return `${safe}.md`;
}

/**
 * Apply normalizeBasename to the filename portion of a full vault path,
 * preserving the directory. Returns the corrected path.
 *
 *   normalizeFilenameInPath("images/photo-12-57.md")
 *     → "images/PHOTO-12-57.md"
 *   normalizeFilenameInPath("foo bar")
 *     → "FOO-BAR.md"
 */
export function normalizeFilenameInPath(filepath: string): string {
  const dir = path.dirname(filepath);
  const base = path.basename(filepath);
  const normalized = normalizeBasename(base);
  return dir === "." ? normalized : `${dir}/${normalized}`;
}
