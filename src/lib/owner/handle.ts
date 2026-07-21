// Profile handles — the public URL slug for a user's shared docs
// (`/share/<handle>/<slug>`). Enforced unique via a Postgres constraint on
// `profiles.handle`; validated here for shape.

export const HANDLE_MIN = 2;
export const HANDLE_MAX = 32;
export const HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

// Path prefixes and app-owned routes that would collide with `/share/<handle>`
// or generally confuse routing. Keep in sync with `app/` route folders + any
// public-facing paths we ship in the future.
export const RESERVED_HANDLES = new Set([
  "admin", "api", "app", "share", "shared", "oauth", "sign-in", "sign-up",
  "me", "cloud-link", "emdee", "vault", "user", "www", "public", "private",
  "settings", "profile", "help", "support", "about", "docs", "assets",
  "static", "_next", "favicon",
]);

export type HandleValidationError =
  | "empty"
  | "too_short"
  | "too_long"
  | "invalid_chars"
  | "reserved";

export function validateHandle(raw: string): { ok: true; handle: string } | { ok: false; error: HandleValidationError } {
  const h = raw.trim().toLowerCase();
  if (!h) return { ok: false, error: "empty" };
  if (h.length < HANDLE_MIN) return { ok: false, error: "too_short" };
  if (h.length > HANDLE_MAX) return { ok: false, error: "too_long" };
  if (!HANDLE_PATTERN.test(h)) return { ok: false, error: "invalid_chars" };
  if (RESERVED_HANDLES.has(h)) return { ok: false, error: "reserved" };
  return { ok: true, handle: h };
}

/**
 * Best-effort deterministic default handle from an email local-part. Strips
 * non-[a-z0-9-] characters, trims leading/trailing hyphens, caps length.
 * Returns null if nothing usable remains — caller should fall back to a
 * clerk-id-derived stub.
 */
export function deriveHandleFromEmail(email: string): string | null {
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  const cleaned = local
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, HANDLE_MAX);
  if (cleaned.length < HANDLE_MIN) return null;
  if (RESERVED_HANDLES.has(cleaned)) return null;
  return cleaned;
}
