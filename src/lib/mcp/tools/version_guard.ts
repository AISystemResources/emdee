// SPRINT-141a (SIG-032 Phase 3 chunk A): shared doc-level version guard.
//
// The primitive: caller submits `expected_content_hash` (from a prior
// get_doc / read). We read current doc content, hash it, compare. Match
// → proceed. Mismatch → return a standardised stale_content response
// so the calling AI can decide (retry with new base, alert user, defer).
//
// Optional-by-default during the SIG-032 transition window — caller
// omits the arg = no guard. A follow-up sprint flips the guard to
// required after downstream callers (CLI, AI clients) have adopted it.
//
// Doc-level hash (whole content), matching get_doc.doc_content_hash.
// Section-level guards live in patch_section / patch_preamble and stay
// there — different granularity, different callers.

import { readVaultFile } from "./vault";
import { hashBody } from "./sections";
import type { ToolContext } from "./types";

export interface StaleContentConflict {
  error: "stale_content";
  path: string;
  expected_content_hash: string;
  actual_content_hash: string;
  current_content_preview: string;
  hint: string;
}

/**
 * Check the caller-supplied expected_content_hash against the current
 * doc content. Returns null if OK (proceed with write); returns a
 * conflict object the tool should surface to the caller if stale.
 *
 * If `expected` is empty/undefined, skips the check — backwards-compat
 * with pre-141a callers.
 */
export async function guardDocContentHash(
  ctx: ToolContext,
  path: string,
  expected: string | undefined,
): Promise<StaleContentConflict | null> {
  if (!expected) return null;
  const current = await readVaultFile(ctx, path);
  if (current === null) {
    // Doc missing — let the caller's own "doc_not_found" path fire;
    // the guard has nothing meaningful to compare against.
    return null;
  }
  const actual = hashBody(current);
  if (actual === expected) return null;
  return {
    error: "stale_content",
    path,
    expected_content_hash: expected,
    actual_content_hash: actual,
    current_content_preview: current.slice(0, 200),
    hint: "Doc changed since you last read it. Call get_doc to fetch the current doc_content_hash + content, reconcile your intended change, and retry.",
  };
}
