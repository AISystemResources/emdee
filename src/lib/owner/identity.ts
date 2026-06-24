// SPRINT-058 (SIG-006): owner-node naming.
//
// The owner node is the user's personal subtree under EMDEE root. Per the
// canonical 4-node vault structure (VAULT / SHARED / GRAVEYARD / MINE),
// MINE is named per-user — by default derived from the user's primary
// email local-part, then renameable any time via the standard rename_doc
// MCP tool.

/**
 * Derive the default owner-node title from an email address.
 *
 *   "elz.work@gmail.com"  → "ELZ-WORK"
 *   "junior_lin@..."      → "JUNIOR-LIN"
 *   "song.wenjuan@..."    → "SONG-WENJUAN"
 *   ""                    → "OWNER" (fallback)
 *
 * Rules:
 *   - take local-part (everything before @)
 *   - uppercase ASCII
 *   - dots / underscores → hyphens
 *   - drop everything that isn't [A-Z0-9-]
 *   - collapse repeated hyphens
 *   - strip leading/trailing hyphens
 *   - fall back to "OWNER" if the result is empty (e.g. all-non-ASCII)
 *
 * Matches SPRINT-055's filename uppercase convention so the file written
 * to the vault is `<TITLE>.md`, identical shape to other EMDEE filenames.
 */
/**
 * Normalise any free-text name into a valid owner-node title.
 * Same rules as email-derived titles so renames stay consistent.
 */
export function normalizeOwnerTitle(input: string): string {
  const normalized = input
    .trim()
    .toUpperCase()
    .replace(/[._\s]/g, "-")
    .replace(/[^A-Z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || "OWNER";
}

export function ownerTitleFromEmail(email: string): string {
  const localPart = (email.split("@")[0] ?? "").trim();
  return normalizeOwnerTitle(localPart);
}

/** The default markdown scaffold for a fresh owner node. */
export function ownerNodeScaffold(title: string): string {
  return `# ${title}

> Your personal subtree. Top-level content (projects, people, notes, etc.) lives here. Renameable any time via \`rename_doc\` — inbound wiki-link references update atomically across the vault.

## Child of

* [[EMDEE]]

## Parent of

## Associated with

## Notes
`;
}
