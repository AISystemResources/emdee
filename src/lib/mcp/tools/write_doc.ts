import { validatePath, writeVaultFile, loadVaultIndex } from "./vault";
import { lintDocContent } from "./lint";
import { evaluateLintGate } from "./lint_gate";
import { buildLintVaultContext } from "./lint_doc";
import { isUppercaseFilename, normalizeFilenameInPath } from "./filename";
import type { ToolContext } from "./types";

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

// Codes whose detection needs vault context (cross-doc lookups). Pulling
// the index is expensive on the hot path, so we only do it when the
// caller explicitly gated on one of these. Keep in sync with lint.ts.
const CROSS_DOC_CODES = new Set([
  "asymmetric_parent_edge",
  "asymmetric_child_edge",
  "sibling_assoc_redundant",
]);

function parseGateCodes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is string => typeof c === "string");
}

/**
 * Create or overwrite a doc. Returns an envelope including any lint warnings
 * surfaced from the just-written content (missing preamble, undeclared
 * inline mentions). Warnings are signal, not gate — the write always
 * succeeds; the caller decides whether to act on them.
 *
 * Opt-in hard gate via `gate_on_warnings: string[]` — when non-empty,
 * the proposed content is linted BEFORE the write; if any warning whose
 * code is in the list fires, the write is skipped and the response is
 * `{ error: "lint_gate_failed", fixes, original_warnings }`. Default
 * `[]` preserves the legacy signal-not-gate behaviour.
 */
export async function writeDoc(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const rel = String(args.path);
  validatePath(rel);

  // SPRINT-055 (SIG-004): refuse non-uppercase filenames at the entry point.
  // Cheaper than letting them in and lint-warning later — keeps the on-disk
  // namespace homogeneous. Auto-fix via `normalizeFilenameInPath` is offered
  // in the error envelope so the caller can re-run without recomputing.
  if (!isUppercaseFilename(rel)) {
    return json({
      error: "filename_not_uppercase",
      path: rel,
      suggested: normalizeFilenameInPath(rel),
      hint: "EMDEE filenames are all-caps ASCII (CLAUDE.md, SPRINT-029.md). Re-run write_doc with `path: <suggested>`.",
    });
  }

  const content = String(args.content ?? "");
  const gateCodes = parseGateCodes(args.gate_on_warnings);

  if (gateCodes.length > 0) {
    const needsVault = gateCodes.some((c) => CROSS_DOC_CODES.has(c));
    const vaultCtx = needsVault ? buildLintVaultContext(await loadVaultIndex(ctx), rel) : undefined;
    const gate = evaluateLintGate(content, gateCodes, vaultCtx);
    if (!gate.ok) {
      return json({ error: "lint_gate_failed", fixes: gate.fixes, original_warnings: gate.original_warnings });
    }
  }

  await writeVaultFile(ctx, rel, content);

  const lint = lintDocContent(content);
  const payload: Record<string, unknown> = { ok: true, path: rel, message: `wrote ${rel}` };
  if (lint.warnings.length > 0) payload.warnings = lint.warnings;
  return json(payload);
}
