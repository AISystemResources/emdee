import path from "node:path";
import { validatePath, readVaultFile, writeVaultFile, loadVaultIndex } from "./vault";
import type { ToolContext } from "./types";
import { validateArgs } from "./validate_args";
import { guardDocContentHash, withHashDeprecation } from "./version_guard";

const ARG_SPEC = {
  allowed: ["source_path", "rewrite_source_content", "extracts", "expected_content_hash"],
  required: ["source_path", "rewrite_source_content", "extracts"],
} as const;

interface ExtractInput {
  path: string;
  content: string;
}

function deriveTitle(rel: string, content: string): string {
  const heading = content.match(/^#\s+(.+)$/m);
  if (heading) return heading[1].trim();
  return path.basename(rel, ".md");
}

/**
 * Atomically refactor a doc into concept nodes.
 *
 * Use this when a doc has grown into multiple distinct reusable ideas
 * (e.g. "TFAR", "Always complete what you've started") that deserve their
 * own nodes the rest of the vault can wiki-link to. Claude builds the
 * extraction plan in chat, then calls split_doc once to execute.
 *
 * Pre-flight checks catch the failure modes that bit us before:
 *  - extract path already exists
 *  - extract H1 title collides with an existing doc (would break the
 *    title→path map the indexer uses for wiki-link resolution)
 *  - two extracts share a path or title
 *
 * On write failure mid-flight, the source rewrite is skipped so the
 * original references aren't orphaned. Any extracts already written
 * stay (idempotent — calling again with the same plan will fail the
 * existence check, which is the desired safety).
 */
async function _splitDoc(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const argErr = validateArgs(args, ARG_SPEC);
  if (argErr) return json(argErr);
  const sourcePath = String(args.source_path ?? "");
  const rewriteContent = String(args.rewrite_source_content ?? "");
  const extracts = Array.isArray(args.extracts) ? (args.extracts as ExtractInput[]) : [];

  if (!sourcePath) return json({ error: "source_path required" });
  if (!rewriteContent) return json({ error: "rewrite_source_content required (provide the new full markdown for the source doc with inline content replaced by wiki-links)" });
  if (extracts.length === 0) return json({ error: "extracts array must be non-empty" });

  validatePath(sourcePath);
  // SPRINT-141a: guard the source doc against stale writes. The caller
  // was working from a snapshot to build the split plan; if the source
  // changed since, the extracts + rewrite are likely inconsistent.
  const expected = args.expected_content_hash !== undefined ? String(args.expected_content_hash) : undefined;
  const sourceConflict = await guardDocContentHash(ctx, sourcePath, expected);
  if (sourceConflict) return json(sourceConflict);
  for (const e of extracts) {
    if (!e || typeof e.path !== "string" || typeof e.content !== "string") {
      return json({ error: "each extract requires { path, content }" });
    }
    validatePath(e.path);
  }

  const index = await loadVaultIndex(ctx);
  const sourceDoc = index.docs.find((d) => d.path === sourcePath);
  if (!sourceDoc) return json({ error: "source_not_found", path: sourcePath });

  const existingPaths = new Set(index.docs.map((d) => d.path));
  const existingTitles = new Map<string, string>();
  for (const d of index.docs) existingTitles.set(d.title.toLowerCase(), d.path);

  const errors: string[] = [];
  const seenPaths = new Set<string>();
  const seenTitles = new Map<string, string>();

  for (const e of extracts) {
    if (seenPaths.has(e.path)) errors.push(`duplicate extract path in plan: ${e.path}`);
    seenPaths.add(e.path);

    if (existingPaths.has(e.path)) errors.push(`path already exists in vault: ${e.path}`);

    const title = deriveTitle(e.path, e.content);
    const titleLc = title.toLowerCase();

    const collidingPath = existingTitles.get(titleLc);
    if (collidingPath && collidingPath !== sourcePath) {
      errors.push(`title "${title}" collides with existing doc ${collidingPath} — pick a different H1 or path`);
    }

    if (seenTitles.has(titleLc)) {
      errors.push(`two extracts share title "${title}": ${seenTitles.get(titleLc)} and ${e.path}`);
    }
    seenTitles.set(titleLc, e.path);
  }

  if (errors.length > 0) {
    return json({ error: "validation_failed", errors });
  }

  // Backup source so we can attempt rollback on partial failure.
  const sourceBackup = await readVaultFile(ctx, sourcePath);
  if (sourceBackup === null) return json({ error: "source_disappeared", path: sourcePath });

  const written: string[] = [];
  try {
    for (const e of extracts) {
      await writeVaultFile(ctx, e.path, e.content);
      written.push(e.path);
    }
    await writeVaultFile(ctx, sourcePath, rewriteContent);
  } catch (err) {
    return json({
      error: "write_failed_mid_flight",
      message: (err as Error).message,
      extracts_written: written,
      source_rewritten: false,
      note: "Source was NOT rewritten so existing references stay valid. Inspect the written extracts and either delete them or call split_doc again with only the remaining extracts.",
    });
  }

  return json({
    ok: true,
    source_rewritten: sourcePath,
    extracts_created: extracts.map((e) => ({
      path: e.path,
      title: deriveTitle(e.path, e.content),
    })),
  });
}

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export const splitDoc = withHashDeprecation(_splitDoc, ["expected_content_hash"]);
