import { loadVaultIndex, readVaultFile, writeVaultFile } from "./vault";
import { lintDocContent, type LintDocInfo, type LintVaultContext, type LintWarning } from "./lint";
import { resolveWikiLink } from "../../../core/resolveLink";
import type { ToolContext } from "./types";

// SPRINT-102 vault-hygiene auto-fix. Tiers add cumulatively:
//
//   Tier 1  (default) — mechanical `## Associated with` bullet removals
//     - sibling_assoc_redundant       : the pair share a parent → assoc is empty
//     - associate_duplicates_hierarchy: the pair are also parent/child → assoc is empty
//   Tier 1.5 (still safe, still mechanical) — repairs the one-parent invariant
//     - multiple_child_of             : keep first `## Child of` bullet as canonical,
//                                        demote the rest to `## Associated with`
//                                        (no data loss; both relationships preserved)
//
// Every fix is idempotent — running twice does nothing on the second pass.
//
// Response:
//   {
//     tier, dry_run, scanned,
//     planned_fixes: [{ path, bullets_to_remove?, parents_to_demote? }],
//     docs_to_modify, bullets_to_remove, parents_to_demote,
//     applied, failed?, remaining_warnings_estimate
//   }

const TIER_1_ASSOC_STRIP_CODES = new Set<LintWarning["code"]>([
  "sibling_assoc_redundant",
  "associate_duplicates_hierarchy",
]);
const TIER_1_5_CODES = new Set<LintWarning["code"]>(["multiple_child_of"]);

const CHILD_OF_HEADING_RE = /^##\s+child of\s*$/i;
const ASSOC_HEADING_RE = /^##\s+associated with\s*$/i;
const H2_RE = /^##\s+/;
const BULLET_RE = /^\s*\*\s*\[\[([^\]]+)\]\]/;

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

interface PerDocPlan {
  path: string;
  bullets_to_remove: string[];   // Tier 1 — lowercase target titles
  parents_to_demote: boolean;    // Tier 1.5 — flag; the fix is "keep first, demote rest"
}

// Locate a section's [startInclusive, endExclusive) line range where
// `headingRe` matches the H2. Returns null if the section is missing.
function findSection(lines: string[], headingRe: RegExp): { start: number; end: number } | null {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (start === -1) {
      if (headingRe.test(lines[i])) start = i + 1;
    } else if (H2_RE.test(lines[i])) {
      return { start, end: i };
    }
  }
  if (start === -1) return null;
  return { start, end: lines.length };
}

// Tier 1: strip specific bullets from ## Associated with.
// Titles are lower-cased for comparison (mirrors what the lint tracks).
function stripAssocBullets(content: string, titlesToDrop: Set<string>): string | null {
  const lines = content.split("\n");
  const section = findSection(lines, ASSOC_HEADING_RE);
  if (!section) return null;
  const before = lines.slice(0, section.start);
  const sectionLines = lines.slice(section.start, section.end);
  const after = lines.slice(section.end);
  const kept: string[] = [];
  for (const line of sectionLines) {
    const m = line.match(BULLET_RE);
    if (m && titlesToDrop.has(m[1].trim().toLowerCase())) continue;
    kept.push(line);
  }
  return [...before, ...kept, ...after].join("\n");
}

// Tier 1.5: keep the first ## Child of wiki-link bullet as canonical,
// move the rest to ## Associated with. Preserves bullet suffixes (any
// " — prose" tail) byte-for-byte. Creates ## Associated with if missing
// (inserted immediately after ## Child of).
//
// Returns { content, demotedCount } or null if no demotion needed.
function demoteExtraChildOf(content: string): { content: string; demotedCount: number } | null {
  const lines = content.split("\n");
  const childSection = findSection(lines, CHILD_OF_HEADING_RE);
  if (!childSection) return null;

  const childLines = lines.slice(childSection.start, childSection.end);
  const bulletIndices: number[] = [];
  for (let i = 0; i < childLines.length; i++) {
    if (BULLET_RE.test(childLines[i])) bulletIndices.push(i);
  }
  if (bulletIndices.length < 2) return null; // nothing to demote

  const firstBulletIdx = bulletIndices[0];
  const extrasLines: string[] = [];
  const newChildLines: string[] = [];
  for (let i = 0; i < childLines.length; i++) {
    if (bulletIndices.includes(i) && i !== firstBulletIdx) {
      extrasLines.push(childLines[i]);
    } else {
      newChildLines.push(childLines[i]);
    }
  }
  // Trim trailing blank lines that were only there to separate demoted
  // bullets from the following H2.
  while (newChildLines.length > 0 && newChildLines[newChildLines.length - 1].trim() === "") {
    newChildLines.pop();
  }
  // Restore one trailing blank if the original section had a spacer.
  newChildLines.push("");

  // Splice new Child of body.
  let out = [
    ...lines.slice(0, childSection.start),
    ...newChildLines,
    ...lines.slice(childSection.end),
  ];

  // Now append the extras to ## Associated with. Look up its position
  // again against the freshly-spliced buffer.
  const assocSection = findSection(out, ASSOC_HEADING_RE);
  if (assocSection) {
    // Insert the extras at the END of the existing section (before the
    // next H2 or EOF). Preserve blank-line spacing.
    const insertAt = assocSection.end;
    // Trim trailing blanks in the current assoc body to keep the append
    // clean, then re-add one blank.
    const before = out.slice(0, insertAt);
    while (before.length > 0 && before[before.length - 1].trim() === "") before.pop();
    out = [
      ...before,
      "",
      ...extrasLines,
      "",
      ...out.slice(insertAt),
    ];
  } else {
    // No ## Associated with — create one right after ## Child of.
    const child2 = findSection(out, CHILD_OF_HEADING_RE);
    if (!child2) return null; // shouldn't happen; defensive
    const insertAt = child2.end;
    out = [
      ...out.slice(0, insertAt),
      "## Associated with",
      "",
      ...extrasLines,
      "",
      ...out.slice(insertAt),
    ];
  }

  return { content: out.join("\n"), demotedCount: extrasLines.length };
}

export async function lintVaultAutofix(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<unknown> {
  const dryRun = args.dry_run !== false;
  const tier = 1.5;

  const index = await loadVaultIndex(ctx);

  // Build shared docInfoByPath once (O(N²)→O(N) — see SPRINT-101 fix).
  const docInfoByPath = new Map<string, LintDocInfo>();
  for (const d of index.docs) {
    docInfoByPath.set(d.path, {
      path: d.path,
      title: d.title,
      declaredParents: d.parents
        .map((l) => resolveWikiLink(index, l.title, d.path)?.path)
        .filter((p): p is string => !!p),
      declaredChildren: d.children
        .map((l) => resolveWikiLink(index, l.title, d.path)?.path)
        .filter((p): p is string => !!p),
    });
  }

  const plans = new Map<string, PerDocPlan>();
  let remainingCount = 0;
  for (const doc of index.docs) {
    const info = docInfoByPath.get(doc.path);
    const lintCtx: LintVaultContext = {
      selfPath: doc.path,
      selfDeclaredParents: info?.declaredParents ?? [],
      resolveTarget: (t) => {
        const resolved = resolveWikiLink(index, t, doc.path);
        return resolved ? (docInfoByPath.get(resolved.path) ?? null) : null;
      },
    };
    const { warnings } = lintDocContent(doc.content, lintCtx);
    const plan: PerDocPlan = { path: doc.path, bullets_to_remove: [], parents_to_demote: false };
    for (const w of warnings) {
      if (TIER_1_ASSOC_STRIP_CODES.has(w.code) && "title" in w && typeof w.title === "string") {
        plan.bullets_to_remove.push(w.title);
      } else if (TIER_1_5_CODES.has(w.code)) {
        plan.parents_to_demote = true;
      } else {
        remainingCount++;
      }
    }
    if (plan.bullets_to_remove.length > 0 || plan.parents_to_demote) {
      plans.set(doc.path, plan);
    }
  }

  const plannedFixes = Array.from(plans.values());
  const totalBullets = plannedFixes.reduce((a, p) => a + p.bullets_to_remove.length, 0);
  const totalDemotes = plannedFixes.filter((p) => p.parents_to_demote).length;

  if (dryRun) {
    return json({
      tier,
      dry_run: true,
      scanned: index.docs.length,
      planned_fixes: plannedFixes,
      docs_to_modify: plannedFixes.length,
      bullets_to_remove: totalBullets,
      parents_to_demote: totalDemotes,
      applied: 0,
      remaining_warnings_estimate: remainingCount,
    });
  }

  let applied = 0;
  const failed: Array<{ path: string; error: string }> = [];
  for (const plan of plannedFixes) {
    try {
      let content = await readVaultFile(ctx, plan.path);
      if (content === null) {
        failed.push({ path: plan.path, error: "doc_not_found" });
        continue;
      }
      const original = content;

      // Tier 1: strip redundant assoc bullets first.
      if (plan.bullets_to_remove.length > 0) {
        const titles = new Set(plan.bullets_to_remove.map((t) => t.toLowerCase()));
        const stripped = stripAssocBullets(content, titles);
        if (stripped !== null) content = stripped;
      }
      // Tier 1.5: demote extra parents after strip so we don't demote
      // into an assoc bullet we're about to remove.
      if (plan.parents_to_demote) {
        const demoted = demoteExtraChildOf(content);
        if (demoted) content = demoted.content;
      }

      if (content === original) {
        applied++;
        continue;
      }
      await writeVaultFile(ctx, plan.path, content);
      applied++;
    } catch (e) {
      failed.push({ path: plan.path, error: (e as Error).message });
    }
  }

  return json({
    tier,
    dry_run: false,
    scanned: index.docs.length,
    planned_fixes: plannedFixes,
    docs_to_modify: plannedFixes.length,
    bullets_to_remove: totalBullets,
    parents_to_demote: totalDemotes,
    applied,
    failed,
    remaining_warnings_estimate: remainingCount,
  });
}
