import path from "node:path";
import { validatePath, readVaultFile, writeVaultFile, deleteVaultFile, loadVaultIndex } from "./vault";
import { adminClient } from "../../supabase/admin";
import type { ToolContext } from "./types";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function deriveTitle(content: string, fallbackPath: string): string {
  const heading = content.match(/^#\s+(.+)$/m);
  if (heading) return heading[1].trim();
  return path.basename(fallbackPath, ".md");
}

function rewriteH1(content: string, newTitle: string): string {
  if (/^#\s+.+$/m.test(content)) {
    return content.replace(/^#\s+.+$/m, `# ${newTitle}`);
  }
  // No H1 — prepend one with the standard blockquote-summary placeholder.
  return `# ${newTitle}\n\n> \n\n${content}`;
}

function sanitizeFilename(title: string): string {
  // Match what the AddChild flow does — strip slashes/backslashes to keep
  // the filename within a single directory. Other characters (spaces,
  // hyphens, dashes) are preserved so titles like "ATLAS — BUILD" map
  // back to "ATLAS — BUILD.md".
  return title.replace(/[/\\]/g, "_");
}

function defaultNewPath(oldPath: string, newTitle: string): string {
  const dir = path.dirname(oldPath);
  const fname = `${sanitizeFilename(newTitle)}.md`;
  return dir === "." ? fname : `${dir}/${fname}`;
}

/**
 * Rewrites every `[[<oldTitle>]]` and `[[<oldTitle>|alias]]` occurrence
 * (case-insensitive) to point at `newTitle`. Aliases are preserved.
 * Returns the new content plus a boolean indicating whether anything
 * changed.
 */
function rewriteWikiLinks(content: string, oldTitle: string, newTitle: string): { content: string; changed: boolean } {
  if (oldTitle.toLowerCase() === newTitle.toLowerCase()) return { content, changed: false };
  const re = new RegExp(`\\[\\[${escapeRegex(oldTitle)}(\\|[^\\]]+)?\\]\\]`, "gi");
  let changed = false;
  const next = content.replace(re, (_match, alias: string | undefined) => {
    changed = true;
    return `[[${newTitle}${alias ?? ""}]]`;
  });
  return { content: next, changed };
}

/**
 * Atomic rename of a doc:
 *  - rewrite its H1 to the new title
 *  - write to the new path (default: same directory, sanitized title)
 *  - delete the old path if it moved
 *  - rewrite all `[[<old_title>]]` references across every other doc
 *  - update doc_shares / share_invitations / sync_manifest path refs
 *    (cloud mode only)
 *
 * Pre-flight checks block destination-path collisions and title
 * collisions with other docs. Self-references inside the doc are
 * rewritten too.
 *
 * On failure during the cross-doc rewrite phase, the renamed doc stays
 * at the new path — partial rewrites are left in place. The caller can
 * re-run with the same args; per-doc writes are idempotent because the
 * old-title links won't be present in already-rewritten docs.
 */
export async function renameDoc(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const oldPath = String(args.old_path ?? "");
  const newTitle = String(args.new_title ?? "").trim();
  const newPath = args.new_path ? String(args.new_path) : defaultNewPath(oldPath, newTitle);

  if (!oldPath) return json({ error: "old_path required" });
  if (!newTitle) return json({ error: "new_title required" });

  validatePath(oldPath);
  validatePath(newPath);

  const oldContent = await readVaultFile(ctx, oldPath);
  if (oldContent === null) return json({ error: "source_not_found", path: oldPath });

  const oldTitle = deriveTitle(oldContent, oldPath);

  const index = await loadVaultIndex(ctx);

  // Pre-flight: destination path must be free unless it equals source.
  if (newPath !== oldPath) {
    const exists = index.docs.some((d) => d.path === newPath);
    if (exists) return json({ error: "destination_path_exists", path: newPath });
  }

  // Pre-flight: new title can't collide with another doc's title (the
  // indexer uses title→path to resolve wiki-links, so duplicates would
  // break navigation).
  if (oldTitle.toLowerCase() !== newTitle.toLowerCase()) {
    const conflict = index.docs.find(
      (d) => d.path !== oldPath && d.title.toLowerCase() === newTitle.toLowerCase()
    );
    if (conflict) {
      return json({ error: "title_conflict", path: conflict.path, title: conflict.title });
    }
  }

  // Stage 1: rewrite the source doc's body (H1 + self-references).
  let updatedSelf = rewriteH1(oldContent, newTitle);
  updatedSelf = rewriteWikiLinks(updatedSelf, oldTitle, newTitle).content;
  await writeVaultFile(ctx, newPath, updatedSelf);
  if (newPath !== oldPath) {
    await deleteVaultFile(ctx, oldPath);
  }

  // Stage 2: rewrite wiki-links in every other doc that mentions oldTitle.
  let docsRewritten = 0;
  for (const d of index.docs) {
    if (d.path === oldPath) continue;
    const result = rewriteWikiLinks(d.content, oldTitle, newTitle);
    if (!result.changed) continue;
    await writeVaultFile(ctx, d.path, result.content);
    docsRewritten++;
  }

  // Stage 3 (cloud only): update DB rows that reference the path directly.
  // doc_shares.path_prefix / share_root, share_invitations.path_prefix /
  // share_root, sync_manifest.file_path (which uses the namespaced form).
  if (ctx.mode === "cloud" && newPath !== oldPath) {
    const admin = adminClient();
    const ownerId = ctx.userId;
    await Promise.all([
      admin.from("doc_shares").update({ path_prefix: newPath })
        .eq("owner_id", ownerId).eq("path_prefix", oldPath),
      admin.from("doc_shares").update({ share_root: newPath })
        .eq("owner_id", ownerId).eq("share_root", oldPath),
      admin.from("share_invitations").update({ path_prefix: newPath })
        .eq("inviter_id", ownerId).eq("path_prefix", oldPath),
      admin.from("share_invitations").update({ share_root: newPath })
        .eq("inviter_id", ownerId).eq("share_root", oldPath),
      admin.from("sync_manifest").update({ file_path: `${ownerId}/${newPath}` })
        .eq("clerk_id", ownerId).eq("file_path", `${ownerId}/${oldPath}`),
    ]);
  }

  return json({
    ok: true,
    old_path: oldPath,
    new_path: newPath,
    old_title: oldTitle,
    new_title: newTitle,
    docs_rewritten: docsRewritten,
  });
}

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}
