// SPRINT-190: default-to-owner enforcement.
//
// Every self-created doc in a user's vault must eventually chain up to
// their owner node. Before this sprint, a `write_doc` (MCP) or `PUT
// /api/doc` (editor autosave) that wrote content lacking a `## Child of`
// section (or with an empty one) produced an orphan — visible in the
// SPRINT-179 sidebar bucket, blocking navigation from the owner root.
//
// Now: any such write auto-injects `* [[<owner-title>]]` under `## Child
// of` so the graph chain stays intact. Callers who genuinely want a
// different parent set it explicitly; the injection is a floor, not a
// ceiling.
//
// Owner-title discovery: query `profiles.handle` for the caller's clerk
// user id, normalise via the existing `normalizeOwnerTitle` helper so the
// result matches the on-disk `<TITLE>.md` filename convention. If no
// handle exists (rare — pre-SPRINT-113 users), fall back to `OWNER`
// which won't resolve but at least logs the intent.

import { adminClient } from "../../supabase/admin";
import { normalizeOwnerTitle } from "../../owner/identity";
import type { ToolContext } from "./types";

/**
 * Return the owner-node title for the caller's namespace, or null in
 * local mode / when the profile lookup fails. Cached per-request via a
 * WeakMap keyed off the ToolContext object so a single tool call that
 * writes multiple docs doesn't repeat the query.
 */
const cache = new WeakMap<object, string | null>();

export async function getOwnerNodeTitle(ctx: ToolContext): Promise<string | null> {
  if (ctx.mode !== "cloud") return null;
  const cached = cache.get(ctx as unknown as object);
  if (cached !== undefined) return cached;
  try {
    const { data } = await adminClient()
      .from("profiles")
      .select("handle")
      .eq("clerk_id", ctx.userId)
      .maybeSingle();
    const handle = (data?.handle as string | null | undefined) ?? "";
    const title = handle ? normalizeOwnerTitle(handle) : null;
    cache.set(ctx as unknown as object, title);
    return title;
  } catch {
    cache.set(ctx as unknown as object, null);
    return null;
  }
}

/**
 * Return true if the content lacks a resolvable Child of bullet — i.e.
 * either no `## Child of` section OR the section body has no `[[...]]`
 * link. Used by write_doc and /api/doc PUT before write to decide
 * whether to inject the default parent.
 */
export function isOrphanContent(content: string): boolean {
  const headingMatch = content.match(/^##\s+Child of\s*$/im);
  if (!headingMatch || headingMatch.index === undefined) return true;
  const start = headingMatch.index + headingMatch[0].length;
  const nextH2 = content.slice(start).search(/^##\s/m);
  const bodyEnd = nextH2 === -1 ? content.length : start + nextH2;
  const body = content.slice(start, bodyEnd);
  return !/\[\[.+?\]\]/.test(body);
}

/**
 * Inject `* [[ownerTitle]]` under `## Child of`. Handles both the
 * missing-section case (insert full section after preamble) and the
 * empty-body case (insert bullet under existing heading). Returns
 * the transformed content; no-op if already well-formed.
 */
export function injectDefaultParent(content: string, ownerTitle: string): string {
  const headingMatch = content.match(/^##\s+Child of\s*$/im);
  if (headingMatch && headingMatch.index !== undefined) {
    const start = headingMatch.index + headingMatch[0].length;
    const nextH2 = content.slice(start).search(/^##\s/m);
    const bodyEnd = nextH2 === -1 ? content.length : start + nextH2;
    const body = content.slice(start, bodyEnd);
    if (/\[\[.+?\]\]/.test(body)) return content; // already has a bullet — no-op
    return content.slice(0, start) + `\n\n* [[${ownerTitle}]]\n\n` + content.slice(bodyEnd);
  }
  // No section at all. Insert before the first H2, or at end if none.
  const firstH2 = content.match(/^##\s/m);
  const insertAt = firstH2 && firstH2.index !== undefined ? firstH2.index : content.length;
  const injection = `## Child of\n\n* [[${ownerTitle}]]\n\n`;
  return content.slice(0, insertAt) + injection + content.slice(insertAt);
}

/**
 * Convenience combinator used by write_doc and /api/doc PUT: inject
 * the default parent iff the content is orphan-shaped AND we could
 * discover the caller's owner title. Returns the possibly-transformed
 * content, safe to pass to the write path.
 */
export async function withDefaultParent(ctx: ToolContext, content: string): Promise<string> {
  if (!isOrphanContent(content)) return content;
  const title = await getOwnerNodeTitle(ctx);
  if (!title) return content; // no handle — can't safely inject; leave as-is
  return injectDefaultParent(content, title);
}
