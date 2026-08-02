import path from "node:path";
import { createHash } from "node:crypto";
import { validatePath, readVaultFile, writeVaultFile, loadVaultIndex } from "./vault";
import { buildLintVaultContext } from "./lint_doc";
import { evaluateLintGate } from "./lint_gate";
import type { LintVaultContext } from "./lint";
import { resolveWikiLink } from "../../../core/resolveLink";
import type { ToolContext } from "./types";
import { validateArgs } from "./validate_args";
import { guardMulti, withHashDeprecation } from "./version_guard";
import { scopeCheckPathWrite } from "../scopes";

const ARG_SPEC = {
  allowed: [
    "path", "new_parent_path", "old_parent_path", "position", "gate_on_warnings",
    "expected_child_content_hash", "expected_old_parent_content_hash", "expected_new_parent_content_hash",
  ],
  required: ["path", "new_parent_path"],
} as const;

// SPRINT-054 (SIG-003): atomic reparenting. Replaces the 3-write manual dance
// (old parent's Parent of, new parent's Parent of, child's Child of) with
// one tool call that handles all three sides + their idempotency guards.

const H1_RE = /^#\s+(.+?)\s*$/m;
const H2_RE = /^##\s+(.+?)\s*$/;
const FENCE_RE = /^\s*(?:```|~~~)/;
const BULLET_LINK_RE = /^\s*[-*]\s+\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/i;

function deriveTitle(content: string, fallbackPath: string): string {
  const m = content.match(H1_RE);
  if (m) return m[1].trim();
  return path.basename(fallbackPath, ".md");
}

function hashBody(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex").slice(0, 16);
}

interface SectionLoc {
  heading: string;
  headingLineIdx: number;
  bodyStartLineIdx: number;
  bodyEndLineIdx: number;
}

function parseSections(content: string): SectionLoc[] {
  const lines = content.split("\n");
  const sections: SectionLoc[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = lines[i].match(H2_RE);
    if (!m) continue;
    if (sections.length > 0) sections[sections.length - 1].bodyEndLineIdx = i;
    sections.push({
      heading: m[1].trim(),
      headingLineIdx: i,
      bodyStartLineIdx: i + 1,
      bodyEndLineIdx: lines.length,
    });
  }
  return sections;
}

function findSection(sections: SectionLoc[], heading: string): SectionLoc | undefined {
  const target = heading.trim().toLowerCase();
  return sections.find((s) => s.heading.toLowerCase() === target);
}

function extractBody(content: string, loc: SectionLoc): string {
  return content
    .split("\n")
    .slice(loc.bodyStartLineIdx, loc.bodyEndLineIdx)
    .join("\n")
    .replace(/^\s*\n+/, "")
    .replace(/\n+\s*$/, "");
}

function extractBulletTitles(content: string, loc: SectionLoc): string[] {
  const lines = content.split("\n").slice(loc.bodyStartLineIdx, loc.bodyEndLineIdx);
  const titles: string[] = [];
  for (const line of lines) {
    const m = line.match(BULLET_LINK_RE);
    if (m) titles.push(m[1].trim());
  }
  return titles;
}

function removeBulletByTitle(
  parentContent: string,
  sectionHeading: string,
  title: string,
): { newContent: string; removed: boolean; newSectionBody: string } {
  const lines = parentContent.split("\n");
  const sections = parseSections(parentContent);
  const section = findSection(sections, sectionHeading);
  if (!section) {
    return { newContent: parentContent, removed: false, newSectionBody: "" };
  }

  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bulletRe = new RegExp(`^\\s*[-*]\\s+\\[\\[${escaped}(\\|[^\\]]+)?\\]\\]`, "i");

  const before = lines.slice(0, section.bodyStartLineIdx);
  const sectionLines = lines.slice(section.bodyStartLineIdx, section.bodyEndLineIdx);
  const after = lines.slice(section.bodyEndLineIdx);

  let removed = false;
  const filtered: string[] = [];
  for (const line of sectionLines) {
    if (!removed && bulletRe.test(line)) {
      removed = true;
      continue;
    }
    filtered.push(line);
  }

  if (!removed) {
    return {
      newContent: parentContent,
      removed: false,
      newSectionBody: extractBody(parentContent, section),
    };
  }

  // Collapse consecutive blank lines that the removal may have created.
  const collapsed: string[] = [];
  for (let i = 0; i < filtered.length; i++) {
    const line = filtered[i];
    const prev = collapsed[collapsed.length - 1];
    if (line.trim() === "" && prev !== undefined && prev.trim() === "") continue;
    collapsed.push(line);
  }

  const newLines = [...before, ...collapsed, ...after];
  const newContent = newLines.join("\n");
  const newSections = parseSections(newContent);
  const newSec = findSection(newSections, sectionHeading);
  return {
    newContent,
    removed: true,
    newSectionBody: newSec ? extractBody(newContent, newSec) : "",
  };
}

function insertBulletInParentOf(
  parentContent: string,
  childTitle: string,
  position?: number,
): { newContent: string; alreadyPresent: boolean; newSectionBody: string } {
  const lines = parentContent.split("\n");
  const sections = parseSections(parentContent);
  const parentOf = findSection(sections, "Parent of");
  const bullet = `* [[${childTitle}]]`;

  if (!parentOf) {
    const sep = parentContent.endsWith("\n") ? "" : "\n";
    const newContent = parentContent + sep + `\n## Parent of\n\n${bullet}\n`;
    return { newContent, alreadyPresent: false, newSectionBody: bullet };
  }

  const sectionLines = lines.slice(parentOf.headingLineIdx, parentOf.bodyEndLineIdx);
  const escaped = childTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const existsRe = new RegExp(`^\\s*[-*]\\s+\\[\\[${escaped}(\\|[^\\]]+)?\\]\\]`, "i");
  if (sectionLines.some((l) => existsRe.test(l))) {
    return {
      newContent: parentContent,
      alreadyPresent: true,
      newSectionBody: extractBody(parentContent, parentOf),
    };
  }

  const body = lines.slice(parentOf.bodyStartLineIdx, parentOf.bodyEndLineIdx);

  if (position === undefined || position < 0) {
    let endIdx = body.length;
    while (endIdx > 0 && body[endIdx - 1].trim() === "") endIdx--;
    const newBody = [...body.slice(0, endIdx), bullet, ...body.slice(endIdx)];
    const newContent = [
      ...lines.slice(0, parentOf.bodyStartLineIdx),
      ...newBody,
      ...lines.slice(parentOf.bodyEndLineIdx),
    ].join("\n");
    const newSections = parseSections(newContent);
    const newSec = findSection(newSections, "Parent of");
    return {
      newContent,
      alreadyPresent: false,
      newSectionBody: newSec ? extractBody(newContent, newSec) : "",
    };
  }

  // Position-based: insert at bullet position N (skipping non-bullet lines).
  let bulletsSeen = 0;
  let insertAt = body.length;
  for (let i = 0; i < body.length; i++) {
    if (BULLET_LINK_RE.test(body[i])) {
      if (bulletsSeen === position) { insertAt = i; break; }
      bulletsSeen++;
    }
  }
  const newBody = [...body.slice(0, insertAt), bullet, ...body.slice(insertAt)];
  const newContent = [
    ...lines.slice(0, parentOf.bodyStartLineIdx),
    ...newBody,
    ...lines.slice(parentOf.bodyEndLineIdx),
  ].join("\n");
  const newSections = parseSections(newContent);
  const newSec = findSection(newSections, "Parent of");
  return {
    newContent,
    alreadyPresent: false,
    newSectionBody: newSec ? extractBody(newContent, newSec) : "",
  };
}

function rewriteChildOf(
  childContent: string,
  newParentTitle: string,
): { newContent: string; newSectionBody: string } {
  const lines = childContent.split("\n");
  const sections = parseSections(childContent);
  const childOf = findSection(sections, "Child of");
  const newBullet = `* [[${newParentTitle}]]`;

  if (!childOf) {
    const sep = childContent.endsWith("\n") ? "" : "\n";
    const newContent = childContent + sep + `\n## Child of\n\n${newBullet}\n`;
    return { newContent, newSectionBody: newBullet };
  }

  const before = lines.slice(0, childOf.bodyStartLineIdx);
  const after = lines.slice(childOf.bodyEndLineIdx);
  const newBody = ["", newBullet, ""];
  const newLines = [...before, ...newBody, ...after];
  return { newContent: newLines.join("\n"), newSectionBody: newBullet };
}

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/**
 * Atomic reparenting. Removes the child's bullet from old parent's
 * `## Parent of`, adds it to new parent's, and rewrites the child's
 * `## Child of` to declare the new parent.
 *
 * Requires:
 * - child_path exists with a `## Child of` section
 * - new_parent_path exists
 * - If the child has more than one Child of bullet, `old_parent_path` MUST
 *   be provided to disambiguate which edge to break; otherwise refuses
 *   with `ambiguous_parent`.
 * - If old_parent_path not provided, resolves it from the child's single
 *   Child of bullet via the indexer.
 *
 * Idempotent: if the child already declares ONLY new_parent_path as its
 * parent AND new_parent already has the child bullet, returns ok with
 * `*_updated: false` on all sides.
 *
 * Write order: child first (Child of update), then old parent (remove
 * bullet), then new parent (add bullet). Partial failure leaves the graph
 * asymmetric; retry is safe — every helper has idempotency built in.
 */
async function _moveDoc(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<unknown> {
  const argErr = validateArgs(args, ARG_SPEC);
  if (argErr) return json(argErr);
  const childPath = String(args.path ?? "");
  const newParentPath = String(args.new_parent_path ?? "");
  const oldParentPathArg =
    args.old_parent_path !== undefined ? String(args.old_parent_path) : "";
  const position =
    args.position !== undefined && typeof args.position === "number"
      ? args.position
      : undefined;
  const gateCodes = Array.isArray(args.gate_on_warnings)
    ? (args.gate_on_warnings as unknown[]).filter((c): c is string => typeof c === "string")
    : [];

  if (!childPath) return json({ error: "path required" });
  if (!newParentPath) return json({ error: "new_parent_path required" });
  if (childPath === newParentPath) {
    return json({ error: "cannot_move_to_self", path: childPath });
  }
  validatePath(childPath);
  validatePath(newParentPath);
  if (oldParentPathArg) validatePath(oldParentPathArg);
  // SPRINT-178: child, new parent, and (when disambiguated) old parent
  // all get Parent-of / Child-of writes. Every path must fall within
  // scope-granted write prefixes.
  {
    const childScopeErr = scopeCheckPathWrite(ctx, childPath);
    if (childScopeErr) return childScopeErr;
    const newParentScopeErr = scopeCheckPathWrite(ctx, newParentPath);
    if (newParentScopeErr) return newParentScopeErr;
    if (oldParentPathArg) {
      const oldParentScopeErr = scopeCheckPathWrite(ctx, oldParentPathArg);
      if (oldParentScopeErr) return oldParentScopeErr;
    }
  }

  const childContent = await readVaultFile(ctx, childPath);
  if (childContent === null) return json({ error: "child_not_found", path: childPath });
  const newParentContent = await readVaultFile(ctx, newParentPath);
  if (newParentContent === null) {
    return json({ error: "new_parent_not_found", path: newParentPath });
  }

  const childSections = parseSections(childContent);
  const childOfLoc = findSection(childSections, "Child of");
  const declaredParentTitles = childOfLoc
    ? extractBulletTitles(childContent, childOfLoc)
    : [];

  const index = await loadVaultIndex(ctx);

  const declaredParentPaths: string[] = [];
  for (const title of declaredParentTitles) {
    const resolved = resolveWikiLink(index, title, childPath);
    if (resolved && resolved.path) declaredParentPaths.push(resolved.path);
  }

  let oldParentPath = oldParentPathArg;
  if (!oldParentPath) {
    if (declaredParentPaths.length === 0) {
      return json({
        error: "no_existing_parent",
        path: childPath,
        hint: "child has no resolvable Child of bullet — use create_child or patch_section to give it a parent first",
      });
    }
    if (declaredParentPaths.length > 1) {
      return json({
        error: "ambiguous_parent",
        path: childPath,
        declared_parents: declaredParentPaths,
        hint: "child has multiple Child of bullets — pass old_parent_path to disambiguate which edge to break",
      });
    }
    oldParentPath = declaredParentPaths[0];
  } else if (!declaredParentPaths.includes(oldParentPath)) {
    return json({
      error: "old_parent_not_declared",
      path: childPath,
      old_parent_path: oldParentPath,
      declared_parents: declaredParentPaths,
      hint: "old_parent_path must match one of the child's existing Child of bullets",
    });
  }

  // SPRINT-108 Fix 1: don't premature-short-circuit on child-only state.
  // The old check assumed "if child declares new_parent as its only parent,
  // both parents are also synced" — which was FALSE when a prior move_doc
  // hit partial_write (child stage committed, old-parent stage failed).
  // Result: old parent kept a stale [[child]] bullet forever, and every
  // retry short-circuited without completing the pending work. Now we
  // ALWAYS read both parent contents + compute all three patches, and
  // rely on each patch's per-stage idempotency check (childChanged,
  // oldParentPatch.removed, newParentPatch.alreadyPresent) to skip writes
  // that would be no-ops.
  //
  // Same-parent case (oldParentPath === newParentPath) is special: we
  // must NOT remove-then-re-add the bullet on the shared parent doc,
  // because the two patches read the same original content and applying
  // both sequentially can flip the bullet's presence incorrectly. Handle
  // by skipping the old-parent step entirely in this case — the
  // new-parent-side insert is idempotent (no-op if already present,
  // insert if missing).
  const oldParentContent = await readVaultFile(ctx, oldParentPath);
  if (oldParentContent === null) {
    return json({ error: "old_parent_not_found", path: oldParentPath });
  }

  // SPRINT-141b: three-side guard. All three docs must match their
  // supplied hashes (if any); first mismatch short-circuits without
  // any writes.
  const conflict = await guardMulti(ctx, [
    { path: childPath, expected: args.expected_child_content_hash !== undefined ? String(args.expected_child_content_hash) : undefined },
    { path: oldParentPath, expected: args.expected_old_parent_content_hash !== undefined ? String(args.expected_old_parent_content_hash) : undefined },
    { path: newParentPath, expected: args.expected_new_parent_content_hash !== undefined ? String(args.expected_new_parent_content_hash) : undefined },
  ]);
  if (conflict) return json(conflict);

  const childTitle = deriveTitle(childContent, childPath);
  const newParentTitle = deriveTitle(newParentContent, newParentPath);

  const samePath = oldParentPath === newParentPath;
  const childPatch = rewriteChildOf(childContent, newParentTitle);
  const oldParentPatch = samePath
    ? { newContent: oldParentContent, newSectionBody: "", removed: false }
    : removeBulletByTitle(oldParentContent, "Parent of", childTitle);
  const newParentPatch = insertBulletInParentOf(newParentContent, childTitle, position);

  if (gateCodes.length > 0) {
    const childCtx: LintVaultContext = buildLintVaultContext(index, childPath);
    const childGate = evaluateLintGate(childPatch.newContent, gateCodes, childCtx);
    if (!childGate.ok) {
      return json({
        error: "lint_gate_failed",
        side: "child",
        fixes: childGate.fixes,
        original_warnings: childGate.original_warnings,
      });
    }
  }

  const prevChildBody = childOfLoc ? extractBody(childContent, childOfLoc) : "";
  const childChanged = childPatch.newSectionBody !== prevChildBody;

  let childWritten = false;
  if (childChanged) {
    try {
      await writeVaultFile(ctx, childPath, childPatch.newContent);
      childWritten = true;
    } catch (err) {
      return json({
        error: "partial_write",
        stage: "child",
        message: (err as Error).message,
      });
    }
  }

  let oldParentWritten = false;
  if (oldParentPatch.removed) {
    try {
      await writeVaultFile(ctx, oldParentPath, oldParentPatch.newContent);
      oldParentWritten = true;
    } catch (err) {
      return json({
        error: "partial_write",
        stage: "old_parent",
        child_written: childWritten,
        message: (err as Error).message,
        retry_hint: "Re-run move_doc; the child write is idempotent.",
      });
    }
  }

  let newParentWritten = false;
  if (!newParentPatch.alreadyPresent) {
    try {
      await writeVaultFile(ctx, newParentPath, newParentPatch.newContent);
      newParentWritten = true;
    } catch (err) {
      return json({
        error: "partial_write",
        stage: "new_parent",
        child_written: childWritten,
        old_parent_written: oldParentWritten,
        message: (err as Error).message,
        retry_hint: "Re-run move_doc; the child + old-parent writes are idempotent.",
      });
    }
  }

  return json({
    ok: true,
    path: childPath,
    new_parent_path: newParentPath,
    old_parent_path: oldParentPath,
    child_updated: childWritten,
    old_parent_updated: oldParentWritten,
    new_parent_updated: newParentWritten,
    child_of_hash: hashBody(childPatch.newSectionBody),
    new_parent_of_hash: hashBody(newParentPatch.newSectionBody),
    old_parent_of_hash: hashBody(oldParentPatch.newSectionBody),
  });
}

export const moveDoc = withHashDeprecation(_moveDoc, ["expected_child_content_hash", "expected_old_parent_content_hash", "expected_new_parent_content_hash"]);
