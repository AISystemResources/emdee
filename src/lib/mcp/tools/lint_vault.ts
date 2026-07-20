import { loadVaultIndex } from "./vault";
import { lintDocContent, type LintWarning, type LintDocInfo, type LintVaultContext } from "./lint";
import { resolveWikiLink } from "../../../core/resolveLink";
import type { ToolContext } from "./types";

// SPRINT-101: batch lint the caller's entire vault in one shot.
//
// Reuses the vault index's in-memory `content` (already fetched by
// `loadVaultIndex`) so we run every per-doc + cross-doc rule without a
// single extra Storage/cache round-trip. On a ~1500-doc vault this is
// milliseconds, not seconds.
//
// Response shape:
//   { scanned, with_warnings, warnings_by_code, docs: [{path, warnings[]}] }
//
// Prefix filter is optional — pass `prefix: "edmund/projects/emdee_os/"`
// to lint a subtree instead of the whole vault. Useful when a hygiene
// pass is scoped to one area and you don't want a punch list of every
// unrelated drift.

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export async function lintVault(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const prefix = typeof args.prefix === "string" && args.prefix.length > 0 ? args.prefix : null;
  const limit = typeof args.limit === "number" && args.limit > 0 ? args.limit : null;

  const index = await loadVaultIndex(ctx);

  // Build the cross-doc info map ONCE up front. The per-doc analog in
  // lint_doc.ts rebuilds this on every call, which is fine for one doc
  // but O(N²) when we're linting the whole vault. Hoisting drops a
  // 1500-doc vault from ~2.25M inner iterations to ~1500.
  const docInfoByPath = new Map<string, LintDocInfo>();
  for (const d of index.docs) {
    const declaredParents = d.parents
      .map((l) => resolveWikiLink(index, l.title, d.path)?.path)
      .filter((p): p is string => !!p);
    const declaredChildren = d.children
      .map((l) => resolveWikiLink(index, l.title, d.path)?.path)
      .filter((p): p is string => !!p);
    docInfoByPath.set(d.path, {
      path: d.path,
      title: d.title,
      declaredParents,
      declaredChildren,
    });
  }

  const perDoc: Array<{ path: string; warnings: LintWarning[] }> = [];
  const byCode: Record<string, number> = {};
  let scanned = 0;

  for (const doc of index.docs) {
    if (prefix && !doc.path.startsWith(prefix)) continue;
    scanned++;
    const selfInfo = docInfoByPath.get(doc.path);
    const selfDeclaredParents = selfInfo?.declaredParents ?? [];
    const lintCtx: LintVaultContext = {
      selfPath: doc.path,
      selfDeclaredParents,
      resolveTarget: (target: string) => {
        const resolved = resolveWikiLink(index, target, doc.path);
        if (!resolved) return null;
        return docInfoByPath.get(resolved.path) ?? null;
      },
    };
    const result = lintDocContent(doc.content, lintCtx);
    if (result.warnings.length === 0) continue;
    perDoc.push({ path: doc.path, warnings: result.warnings });
    for (const w of result.warnings) {
      byCode[w.code] = (byCode[w.code] ?? 0) + 1;
    }
  }

  // Sort docs with most warnings first — top of the punch list is where
  // the operator's attention buys the most cleanup per unit of effort.
  perDoc.sort((a, b) => b.warnings.length - a.warnings.length);
  const docs = limit ? perDoc.slice(0, limit) : perDoc;

  return json({
    scanned,
    with_warnings: perDoc.length,
    warnings_total: Object.values(byCode).reduce((a, b) => a + b, 0),
    warnings_by_code: byCode,
    docs,
  });
}
