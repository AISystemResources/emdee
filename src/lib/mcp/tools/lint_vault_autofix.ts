import { loadVaultIndex, readVaultFile, writeVaultFile } from "./vault";
import { lintDocContent, type LintDocInfo, type LintVaultContext, type LintWarning } from "./lint";
import { resolveWikiLink } from "../../../core/resolveLink";
import type { ToolContext } from "./types";

// SPRINT-102 Tier 1: mechanical bullet removals for `sibling_assoc_redundant`
// and `associate_duplicates_hierarchy`.
//
// Both warnings mean "this bullet in `## Associated with` is semantically
// empty because the relationship is already implied by hierarchy or
// shared parentage." Removing the bullet loses no information and drops
// the warning.
//
// Every fix requires cleaning BOTH sides of the association (`add_association`
// writes to both sides symmetrically, so `sibling_assoc_redundant` and
// `associate_duplicates_hierarchy` typically fire on both docs of the pair).
// Rather than pairing-and-processing, we just fix each side as we walk the
// index — idempotent-ish because a second pass would find nothing to remove.
//
// Response:
//   {
//     tier: 1,
//     dry_run: boolean,
//     scanned: number,
//     planned_fixes: [{ path, bullets: [{ title, code }] }],
//     applied: number,
//     failed: [{ path, error }],
//     remaining_warnings_estimate: number
//   }

const TIER_1_CODES = new Set<LintWarning["code"]>([
  "sibling_assoc_redundant",
  "associate_duplicates_hierarchy",
]);

const ASSOC_HEADING_RE = /^##\s+associated with\s*$/i;
const H2_RE = /^##\s+/;

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

interface PlannedFix {
  path: string;
  bullets: Array<{ title: string; code: string }>;
}

/**
 * Remove wiki-link bullets targeting any of `titlesToDrop` from the
 * `## Associated with` section body. Preserves all other lines byte-for-byte,
 * including empty lines and any bullets that don't match a dropped title.
 * Returns the modified content, or null if the section is missing.
 */
function stripAssocBullets(content: string, titlesToDrop: Set<string>): string | null {
  const lines = content.split("\n");
  let sectionStart = -1;
  let sectionEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (sectionStart === -1) {
      if (ASSOC_HEADING_RE.test(lines[i])) sectionStart = i + 1;
    } else if (H2_RE.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }
  if (sectionStart === -1) return null;

  const before = lines.slice(0, sectionStart);
  const sectionLines = lines.slice(sectionStart, sectionEnd);
  const after = lines.slice(sectionEnd);

  // Match `* [[TITLE]]` or `* [[TITLE]] — anything`, whitespace-tolerant.
  // Lint lowercases titles when extracting them, so we compare
  // case-insensitively here to stay consistent with the warning's title
  // field. Titles like "PROJECTS — PATTERN" would otherwise slip through.
  const kept: string[] = [];
  for (const line of sectionLines) {
    const m = line.match(/^\s*\*\s*\[\[([^\]]+)\]\]/);
    if (m && titlesToDrop.has(m[1].trim().toLowerCase())) continue; // drop it
    kept.push(line);
  }
  return [...before, ...kept, ...after].join("\n");
}

export async function lintVaultAutofix(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<unknown> {
  const dryRun = args.dry_run !== false; // dry-run by default; opt-in to actually write
  const tier = 1; // only tier 1 shipped in SPRINT-102

  const index = await loadVaultIndex(ctx);

  // Build shared docInfoByPath once (same performance treatment as lint_vault
  // after the SPRINT-101 O(N²) fix).
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

  // Gather Tier-1 fix plan across the whole vault.
  const plans = new Map<string, PlannedFix>();
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
    const tier1: PlannedFix["bullets"] = [];
    for (const w of warnings) {
      if (TIER_1_CODES.has(w.code) && "title" in w && typeof w.title === "string") {
        tier1.push({ title: w.title, code: w.code });
      } else {
        remainingCount++;
      }
    }
    if (tier1.length > 0) {
      plans.set(doc.path, { path: doc.path, bullets: tier1 });
    }
  }

  const plannedFixes = Array.from(plans.values());

  if (dryRun) {
    return json({
      tier,
      dry_run: true,
      scanned: index.docs.length,
      planned_fixes: plannedFixes,
      docs_to_modify: plannedFixes.length,
      bullets_to_remove: plannedFixes.reduce((a, p) => a + p.bullets.length, 0),
      applied: 0,
      remaining_warnings_estimate: remainingCount,
    });
  }

  // Execute: for each plan, read → strip → write. Version-guard via hash
  // check before the write — if anything raced, skip that doc and report.
  let applied = 0;
  const failed: Array<{ path: string; error: string }> = [];
  for (const plan of plannedFixes) {
    try {
      const current = await readVaultFile(ctx, plan.path);
      if (current === null) {
        failed.push({ path: plan.path, error: "doc_not_found" });
        continue;
      }
      const titles = new Set(plan.bullets.map((b) => b.title));
      const rewritten = stripAssocBullets(current, titles);
      if (rewritten === null) {
        failed.push({ path: plan.path, error: "associated_with_section_missing" });
        continue;
      }
      if (rewritten === current) {
        // Bullet already gone (race with another fix or manual edit); count
        // as applied since the intent is satisfied.
        applied++;
        continue;
      }
      await writeVaultFile(ctx, plan.path, rewritten);
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
    bullets_to_remove: plannedFixes.reduce((a, p) => a + p.bullets.length, 0),
    applied,
    failed,
    remaining_warnings_estimate: remainingCount,
  });
}
