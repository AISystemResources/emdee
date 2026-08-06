import { validatePath, readVaultFile, writeVaultFile, loadVaultIndex } from "./vault";
import { lintDocContent } from "./lint";
import { evaluateLintGate } from "./lint_gate";
import { buildLintVaultContext } from "./lint_doc";
import {
  parseSections,
  extractBody,
  hashBody,
  sectionId,
  resolveSection,
  type SectionLoc,
} from "./sections";
import type { ToolContext } from "./types";
import { validateArgs } from "./validate_args";
import { scopeCheckPathWrite } from "../scopes";

const CROSS_DOC_CODES = new Set([
  "asymmetric_parent_edge",
  "asymmetric_child_edge",
  "sibling_assoc_redundant",
]);

const ARG_SPEC = {
  allowed: ["path", "heading", "section_id", "body", "expected_content_hash", "gate_on_warnings", "force_relationship_write"],
  required: ["path", "body", "expected_content_hash"],
} as const;

function parseGateCodes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is string => typeof c === "string");
}

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export async function patchSection(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const argErr = validateArgs(args, ARG_SPEC);
  if (argErr) return json(argErr);
  const rel = String(args.path);
  validatePath(rel);
  const scopeErr = scopeCheckPathWrite(ctx, rel); // SPRINT-178
  if (scopeErr) return scopeErr;
  const headingArg = args.heading !== undefined ? String(args.heading).trim() : "";
  const sectionIdArg = args.section_id !== undefined ? String(args.section_id).trim() : "";
  const body = String(args.body ?? "");
  const expected = String(args.expected_content_hash ?? "");
  if (!headingArg && !sectionIdArg) throw new Error("heading or section_id required");
  if (!expected) throw new Error("expected_content_hash required");

  const content = await readVaultFile(ctx, rel);
  if (content === null) return json({ error: "doc_not_found", path: rel });

  const sections = parseSections(content);
  const resolved = resolveSection(sections, sectionIdArg, headingArg);
  if (resolved.kind === "mismatch") {
    return json({
      error: "section_id_heading_mismatch",
      section_id_resolves_to: resolved.section_id_resolves_to,
      heading_resolves_to: resolved.heading_resolves_to,
    });
  }
  if (resolved.kind === "not_found") {
    return json({
      error: "section_not_found",
      heading: headingArg || undefined,
      section_id: sectionIdArg || undefined,
      available: resolved.available,
    });
  }
  const target: SectionLoc = resolved.loc;

  // SPRINT-180: hard-refuse hierarchy / association section writes unless
  // the caller explicitly opts in. Promotes the SPRINT-136 soft-warning
  // (2026-07-25) to a machine-enforced rule so drift stops being possible
  // to introduce silently. The atomic tools (`move_doc`, `create_child`,
  // `add_association`) patch both sides in one transaction — use them
  // instead. `force_relationship_write: true` is the escape hatch for
  // legit dual-side repairs (e.g. re-parenting a truly orphaned doc where
  // move_doc has no old_parent to point at).
  const relKind = relationshipSectionKind(target.heading);
  if (relKind && args.force_relationship_write !== true) {
    return json({
      error: "hierarchy_section_write_refused",
      section: target.heading,
      kind: relKind,
      hint: relKind === "hierarchy"
        ? "This is a `## Child of` / `## Parent of` section — patching one side leaves the graph asymmetric. Use `move_doc` (existing parent) or `create_child` (new parent) instead. If you must patch by hand, pass `force_relationship_write: true` AND patch the other side in the same turn."
        : "This is a `## Associated with` section — patching one side leaves the association asymmetric. Use `add_association` instead. If you must patch by hand, pass `force_relationship_write: true` AND patch the other side in the same turn.",
      atomic_tool: relKind === "hierarchy" ? ["move_doc", "create_child"] : ["add_association"],
    });
  }

  const currentBody = extractBody(content, target);
  const currentHash = hashBody(currentBody);
  if (currentHash !== expected) {
    return json({ error: "version_conflict", heading: target.heading, expected_content_hash: expected, actual_content_hash: currentHash, message: "Section was modified since you last read it. Call get_doc again and reconcile." });
  }

  const lines = content.split("\n");
  const newContent = [
    ...lines.slice(0, target.headingLineIdx + 1),
    "",
    ...body.split("\n"),
    "",
    ...lines.slice(target.bodyEndLineIdx),
  ].join("\n");

  const gateCodes = parseGateCodes(args.gate_on_warnings);
  if (gateCodes.length > 0) {
    const needsVault = gateCodes.some((c) => CROSS_DOC_CODES.has(c));
    const vaultCtx = needsVault ? buildLintVaultContext(await loadVaultIndex(ctx), rel) : undefined;
    const gate = evaluateLintGate(newContent, gateCodes, vaultCtx);
    if (!gate.ok) {
      return json({ error: "lint_gate_failed", fixes: gate.fixes, original_warnings: gate.original_warnings });
    }
  }

  await writeVaultFile(ctx, rel, newContent);

  // Re-derive ordinal under the new content so the returned section_id
  // remains stable for chained edits (the section may have shifted
  // position if the body insertion grew it). In practice patch_section
  // never reshuffles H2 order — included defensively.
  const newSections = parseSections(newContent);
  const newIdx = newSections.findIndex((s) => s.heading === target!.heading);
  const newId = newIdx >= 0 ? sectionId(target!.heading, newIdx) : undefined;

  const lint = lintDocContent(newContent);
  const payload: Record<string, unknown> = {
    ok: true,
    content_hash: hashBody(body.trim()),
    section_id: newId,
  };
  if (lint.warnings.length > 0) payload.warnings = lint.warnings;

  // SPRINT-180: reaching here on a relationship section means the caller
  // passed `force_relationship_write: true`. Keep the reminder in the
  // response so the two-sided obligation is visible in logs.
  if (relKind) {
    const existing = Array.isArray(payload.warnings) ? payload.warnings : [];
    payload.warnings = [
      ...existing,
      {
        code: "relationship_section_forced_write",
        message: relKind === "hierarchy"
          ? "Forced hierarchy-section write. You MUST patch the reciprocal side (parent's Parent of / child's Child of) in the same turn, or run `reconcile` after."
          : "Forced association write. You MUST patch the reciprocal side (other doc's Associated with) in the same turn.",
      },
    ];
  }

  return json(payload);
}

// SPRINT-180: classify a section heading. Returns "hierarchy" for
// Child of / Parent of, "assoc" for Associated with, null otherwise.
// Case-insensitive on the leading keyword since users occasionally
// author `## child of`. Same detection previously drove the SPRINT-136
// soft-warning.
function relationshipSectionKind(headingRaw: string): "hierarchy" | "assoc" | null {
  const h = headingRaw.trim().toLowerCase();
  if (h === "child of" || h === "parent of") return "hierarchy";
  if (h === "associated with") return "assoc";
  return null;
}
