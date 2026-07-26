import { createHash } from "node:crypto";
import { validatePath, readVaultFile, writeVaultFile, loadVaultIndex } from "./vault";
import { evaluateLintGate } from "./lint_gate";
import { buildLintVaultContext } from "./lint_doc";
import type { ToolContext } from "./types";
import { validateArgs } from "./validate_args";
import { guardDocContentHash, withHashDeprecation } from "./version_guard";

const CROSS_DOC_CODES = new Set([
  "asymmetric_parent_edge",
  "asymmetric_child_edge",
  "sibling_assoc_redundant",
]);

const ARG_SPEC = {
  allowed: ["path", "body", "gate_on_warnings", "expected_content_hash"],
  required: ["path", "body"],
} as const;

function parseGateCodes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is string => typeof c === "string");
}

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function hashBody(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex").slice(0, 16);
}

/**
 * Append content to the very end of a doc — after every existing section.
 *
 * Separate from `append_section`, which lands inside a named section's body
 * (which is *mid-doc* whenever that section isn't last). For chronological
 * note-taking — LOGS entries, daily notes, anywhere new content should land
 * at the bottom of the page regardless of section structure — this is the
 * right primitive. The body may include its own `##` headings to introduce
 * new sections at the end.
 */
async function _appendDoc(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const argErr = validateArgs(args, ARG_SPEC);
  if (argErr) return json(argErr);
  const rel = String(args.path);
  validatePath(rel);
  const expected = args.expected_content_hash !== undefined ? String(args.expected_content_hash) : undefined;
  const conflict = await guardDocContentHash(ctx, rel, expected);
  if (conflict) return json(conflict);
  const body = String(args.body ?? "");
  if (!body.trim()) throw new Error("body required");

  const content = await readVaultFile(ctx, rel);
  if (content === null) return json({ error: "doc_not_found", path: rel });

  // Normalise trailing whitespace so the new content starts on its own
  // paragraph, regardless of whether the existing doc ended cleanly.
  const trimmed = content.replace(/\s+$/, "");
  const newContent = trimmed + "\n\n" + body.replace(/\s+$/, "") + "\n";

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
  return json({ ok: true, content_hash: hashBody(body.trim()) });
}

export const appendDoc = withHashDeprecation(_appendDoc, ["expected_content_hash"]);
