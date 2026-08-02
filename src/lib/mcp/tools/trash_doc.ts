import { validatePath, readVaultFile, loadVaultIndex } from "./vault";
import { resolveWikiLink } from "../../../core/resolveLink";
import { readTrashedState, writeTrashedState } from "../../trash/state";
import type { ToolContext } from "./types";
import { validateArgs } from "./validate_args";
import { guardDocContentHash, withHashDeprecation } from "./version_guard";
import { scopeCheckPathWrite } from "../scopes";

const ARG_SPEC = {
  allowed: ["path", "original_parent_path", "expected_content_hash"],
  required: ["path"],
} as const;

// SPRINT-057 (SIG-008): trash a doc by flagging it in the .emdee/trashed.json
// sidecar. The markdown is untouched; original Child of / Parent of edges
// stay in the file so restore is lossless. The trash flag is what the
// renderer consults to hide it from non-graveyard views.
//
// Pre-flight requires the doc to declare a parent via `## Child of`. The
// first declared parent becomes the restore target. Multi-parent docs use
// the first bullet — pass `original_parent_path` to override.

const H2_RE = /^##\s+(.+?)\s*$/;
const FENCE_RE = /^\s*(?:```|~~~)/;
const BULLET_LINK_RE = /^\s*[-*]\s+\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/i;

function findChildOfFirstWikiLink(content: string): string | null {
  const lines = content.split("\n");
  let inFence = false;
  let inChildOf = false;
  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const h = line.match(H2_RE);
    if (h) {
      inChildOf = h[1].trim().toLowerCase() === "child of";
      continue;
    }
    if (!inChildOf) continue;
    const m = line.match(BULLET_LINK_RE);
    if (m) return m[1].trim();
  }
  return null;
}

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

async function _trashDoc(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<unknown> {
  const argErr = validateArgs(args, ARG_SPEC);
  if (argErr) return json(argErr);
  const docPath = String(args.path ?? "");
  const explicitParent =
    args.original_parent_path !== undefined ? String(args.original_parent_path) : "";

  if (!docPath) return json({ error: "path required" });
  validatePath(docPath);
  if (explicitParent) validatePath(explicitParent);
  const scopeErr = scopeCheckPathWrite(ctx, docPath); // SPRINT-178
  if (scopeErr) return scopeErr;

  const content = await readVaultFile(ctx, docPath);
  if (content === null) return json({ error: "doc_not_found", path: docPath });

  // SPRINT-141b: version-guard the doc being trashed if the caller passed a hash.
  const expected = args.expected_content_hash !== undefined ? String(args.expected_content_hash) : undefined;
  const conflict = await guardDocContentHash(ctx, docPath, expected);
  if (conflict) return json(conflict);

  // Resolve original parent. Explicit arg wins; otherwise derive from the
  // doc's first Child of bullet via the indexer.
  let originalParent = explicitParent;
  if (!originalParent) {
    const parentTitle = findChildOfFirstWikiLink(content);
    if (!parentTitle) {
      return json({
        error: "no_resolvable_parent",
        path: docPath,
        hint: "doc has no `## Child of` bullet — pass original_parent_path to record an explicit restore target, or give the doc a parent via patch_section first",
      });
    }
    const index = await loadVaultIndex(ctx);
    const resolved = resolveWikiLink(index, parentTitle, docPath);
    if (!resolved || !resolved.path) {
      return json({
        error: "unresolved_parent",
        path: docPath,
        declared_parent_title: parentTitle,
        hint: "the doc's Child of bullet points to a non-existent doc — pass original_parent_path to record an explicit restore target",
      });
    }
    originalParent = resolved.path;
  }

  // Idempotent: already-trashed doc returns ok with the existing entry.
  const state = await readTrashedState(ctx);
  if (state[docPath]) {
    return json({
      ok: true,
      path: docPath,
      original_parent_path: state[docPath].original_parent_path,
      trashed_at: state[docPath].trashed_at,
      already_trashed: true,
    });
  }

  const trashedAt = new Date().toISOString();
  state[docPath] = { original_parent_path: originalParent, trashed_at: trashedAt };
  await writeTrashedState(ctx, state);

  return json({
    ok: true,
    path: docPath,
    original_parent_path: originalParent,
    trashed_at: trashedAt,
    already_trashed: false,
  });
}

export const trashDoc = withHashDeprecation(_trashDoc, ["expected_content_hash"]);
