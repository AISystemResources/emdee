import { loadVaultIndex, readVaultFile, writeVaultFile } from "./vault";
import { lintDocContent, type LintDocInfo, type LintVaultContext, type LintWarning } from "./lint";
import { resolveWikiLink } from "../../../core/resolveLink";
import { SYSTEM_NODE_PATHS } from "../../system-nodes";
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
//   Tier 2a (safe: no constraint risk) — repairs reciprocity, adding-side
//     - asymmetric_child_edge         : doc A declares [[B]] as parent, B doesn't
//                                        list A back → add `[[A]]` to B's ## Parent of.
//                                        Parent of has no cardinality constraint, so
//                                        this can't violate one_parent.
//   Tier 2b (heuristic: constraint-aware) — repairs the tricky direction
//     - asymmetric_parent_edge        : doc A declares [[B]] as child, B doesn't
//                                        list A as parent → two possible fixes,
//                                        picked by target state:
//                                        (i) B has 0 declared parents AND is the
//                                            first claimer we see → add [[A]] to
//                                            B's ## Child of (restore full edge)
//                                        (ii) B has ≥1 parent, OR is already being
//                                            claimed by another add plan → remove
//                                            [[B]] from A's ## Parent of (drop the
//                                            false claim; B has canonical parent).
//                                        The heuristic avoids ever adding a second
//                                        Child of bullet — which would violate the
//                                        one_parent constraint.
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
const TIER_2A_CODES = new Set<LintWarning["code"]>(["asymmetric_child_edge"]);
const TIER_2B_CODES = new Set<LintWarning["code"]>(["asymmetric_parent_edge"]);

const CHILD_OF_HEADING_RE = /^##\s+child of\s*$/i;
const PARENT_OF_HEADING_RE = /^##\s+parent of\s*$/i;
const ASSOC_HEADING_RE = /^##\s+associated with\s*$/i;
const H2_RE = /^##\s+/;
const BULLET_RE = /^\s*\*\s*\[\[([^\]]+)\]\]/;

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

interface PerDocPlan {
  path: string;
  bullets_to_remove: string[];      // Tier 1 — lowercase target titles for assoc strip
  parents_to_demote: boolean;       // Tier 1.5 — flag; fix is "keep first, demote rest"
  add_parent_of_bullets: string[];  // Tier 2a — child titles to add to this doc's ## Parent of
  add_child_of_bullet: string | null; // Tier 2b — single parent title to add to this doc's ## Child of (only when doc has 0 parents)
  remove_parent_of_bullets: string[]; // Tier 2b — child titles to remove from this doc's ## Parent of (false claims)
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

// Tier 2b: add a single `* [[TITLE]]` bullet to the doc's ## Child of
// section. Only ever called on docs with 0 existing declared parents,
// so it can safely INSERT rather than APPEND (a fresh Child of should
// hold one canonical parent). Creates the section if missing.
// Idempotent: no-op if the title is already declared.
function addChildOfBullet(content: string, title: string): { content: string; changed: boolean } | null {
  const lines = content.split("\n");
  const childSection = findSection(lines, CHILD_OF_HEADING_RE);
  if (childSection) {
    for (let i = childSection.start; i < childSection.end; i++) {
      const m = lines[i].match(BULLET_RE);
      if (m && m[1].trim().toLowerCase() === title.toLowerCase()) {
        return { content, changed: false };
      }
    }
    // Append the bullet to the existing section.
    const before = lines.slice(0, childSection.end);
    while (before.length > 0 && before[before.length - 1].trim() === "") before.pop();
    const out = [...before, `* [[${title}]]`, "", ...lines.slice(childSection.end)];
    return { content: out.join("\n"), changed: true };
  }
  // No ## Child of — insert right after preamble (before first H2, or
  // at start of doc if no H2 yet).
  let firstH2Idx = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (H2_RE.test(lines[i])) { firstH2Idx = i; break; }
  }
  const out = [
    ...lines.slice(0, firstH2Idx),
    "## Child of",
    "",
    `* [[${title}]]`,
    "",
    ...lines.slice(firstH2Idx),
  ];
  return { content: out.join("\n"), changed: true };
}

// Tier 2b (remove side): drop specific title bullets from the doc's
// ## Parent of section. Preserves everything else byte-for-byte.
function removeParentOfBullets(content: string, titlesToDrop: Set<string>): { content: string; changed: boolean } | null {
  const lines = content.split("\n");
  const section = findSection(lines, PARENT_OF_HEADING_RE);
  if (!section) return { content, changed: false };
  const before = lines.slice(0, section.start);
  const sectionLines = lines.slice(section.start, section.end);
  const after = lines.slice(section.end);
  const kept: string[] = [];
  let dropped = 0;
  for (const line of sectionLines) {
    const m = line.match(BULLET_RE);
    if (m && titlesToDrop.has(m[1].trim().toLowerCase())) { dropped++; continue; }
    kept.push(line);
  }
  if (dropped === 0) return { content, changed: false };
  return { content: [...before, ...kept, ...after].join("\n"), changed: true };
}

// Tier 2a: add missing `* [[TITLE]]` back-edge bullets to the doc's
// ## Parent of section. If the section doesn't exist, create it right
// after ## Child of (or at end of doc if Child of also missing).
// Idempotent: skips titles already present in the section.
function addParentOfBullets(content: string, titlesToAdd: string[]): { content: string; added: number } | null {
  if (titlesToAdd.length === 0) return { content, added: 0 };
  const lines = content.split("\n");
  const parentSection = findSection(lines, PARENT_OF_HEADING_RE);
  if (parentSection) {
    // Skip titles already listed (case-insensitive).
    const existing = new Set<string>();
    for (let i = parentSection.start; i < parentSection.end; i++) {
      const m = lines[i].match(BULLET_RE);
      if (m) existing.add(m[1].trim().toLowerCase());
    }
    const toActuallyAdd = titlesToAdd.filter((t) => !existing.has(t.toLowerCase()));
    if (toActuallyAdd.length === 0) return { content, added: 0 };
    const bullets = toActuallyAdd.map((t) => `* [[${t}]]`);
    const before = lines.slice(0, parentSection.end);
    // Trim trailing blanks in the section, then append bullets + one blank.
    while (before.length > 0 && before[before.length - 1].trim() === "") before.pop();
    const out = [...before, ...bullets, "", ...lines.slice(parentSection.end)];
    return { content: out.join("\n"), added: toActuallyAdd.length };
  }
  // No ## Parent of — insert after ## Child of if present, else at end.
  const bullets = titlesToAdd.map((t) => `* [[${t}]]`);
  const childSection = findSection(lines, CHILD_OF_HEADING_RE);
  const insertAt = childSection ? childSection.end : lines.length;
  const out = [
    ...lines.slice(0, insertAt),
    "## Parent of",
    "",
    ...bullets,
    "",
    ...lines.slice(insertAt),
  ];
  return { content: out.join("\n"), added: titlesToAdd.length };
}

export async function lintVaultAutofix(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<unknown> {
  const dryRun = args.dry_run !== false;
  const tier = 2; // Tier 1 + 1.5 + 2a + 2b — full mechanical + heuristic coverage

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
  const getOrInit = (p: string): PerDocPlan => {
    let plan = plans.get(p);
    if (!plan) {
      plan = {
        path: p,
        bullets_to_remove: [],
        parents_to_demote: false,
        add_parent_of_bullets: [],
        add_child_of_bullet: null,
        remove_parent_of_bullets: [],
      };
      plans.set(p, plan);
    }
    return plan;
  };
  // Tier 2b bookkeeping: for each target, whether an add-Child-of plan
  // has been claimed for it. Second-and-later claimants fall to remove.
  const claimedForChildOfAdd = new Set<string>();
  let remainingCount = 0;
  for (const doc of index.docs) {
    // Virtual system nodes (EMDEE / VAULT / GRAVEYARD / IMAGES / SHARED) are
    // injected read-only from src/lib/system-nodes.ts and don't have real
    // Storage rows. Skip both directions: don't scan them for warnings,
    // and don't propose them as fix targets. Writes would silently no-op
    // and re-runs would perpetually re-plan the same "fix."
    if (SYSTEM_NODE_PATHS.has(doc.path)) continue;
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
    for (const w of warnings) {
      if (TIER_1_ASSOC_STRIP_CODES.has(w.code) && "title" in w && typeof w.title === "string") {
        getOrInit(doc.path).bullets_to_remove.push(w.title);
      } else if (TIER_1_5_CODES.has(w.code)) {
        getOrInit(doc.path).parents_to_demote = true;
      } else if (TIER_2A_CODES.has(w.code) && "asymmetric_target" in w && typeof w.asymmetric_target === "string") {
        // asymmetric_child_edge: doc.path declares [[TARGET]] as parent,
        // but TARGET doesn't list doc.path as child. Fix modifies TARGET
        // (add doc.title to TARGET's ## Parent of). Route the fix by
        // resolving the target's path.
        const targetResolved = resolveWikiLink(index, w.asymmetric_target, doc.path);
        if (!targetResolved || SYSTEM_NODE_PATHS.has(targetResolved.path)) {
          // Virtual target — can't back-edge into a read-only injected node.
          remainingCount++;
          continue;
        }
        getOrInit(targetResolved.path).add_parent_of_bullets.push(doc.title);
      } else if (TIER_2B_CODES.has(w.code) && "asymmetric_target" in w && typeof w.asymmetric_target === "string") {
        // asymmetric_parent_edge: doc.path declares [[TARGET]] as child,
        // TARGET doesn't list doc.path as parent. Heuristic:
        //   - TARGET has 0 declared parents AND no other doc already
        //     claimed the add slot → add [[doc.title]] to TARGET's Child of
        //   - Otherwise → remove [[TARGET]] from doc.path's Parent of
        //     (the false claim; TARGET has a canonical parent or another
        //     doc got dibs on adding).
        const targetResolved = resolveWikiLink(index, w.asymmetric_target, doc.path);
        if (!targetResolved || SYSTEM_NODE_PATHS.has(targetResolved.path)) {
          remainingCount++;
          continue;
        }
        const targetInfo = docInfoByPath.get(targetResolved.path);
        const targetHasParent = (targetInfo?.declaredParents.length ?? 0) > 0;
        if (!targetHasParent && !claimedForChildOfAdd.has(targetResolved.path)) {
          claimedForChildOfAdd.add(targetResolved.path);
          getOrInit(targetResolved.path).add_child_of_bullet = doc.title;
        } else {
          // Remove the false claim from doc's Parent of.
          getOrInit(doc.path).remove_parent_of_bullets.push(w.asymmetric_target);
        }
      } else {
        remainingCount++;
      }
    }
  }

  const plannedFixes = Array.from(plans.values());
  const totalBullets = plannedFixes.reduce((a, p) => a + p.bullets_to_remove.length, 0);
  const totalDemotes = plannedFixes.filter((p) => p.parents_to_demote).length;
  const totalBackEdges = plannedFixes.reduce((a, p) => a + p.add_parent_of_bullets.length, 0);
  const totalChildOfAdds = plannedFixes.filter((p) => p.add_child_of_bullet !== null).length;
  const totalFalseClaimsRemoved = plannedFixes.reduce((a, p) => a + p.remove_parent_of_bullets.length, 0);

  if (dryRun) {
    return json({
      tier,
      dry_run: true,
      scanned: index.docs.length,
      planned_fixes: plannedFixes,
      docs_to_modify: plannedFixes.length,
      bullets_to_remove: totalBullets,
      parents_to_demote: totalDemotes,
      back_edges_to_add: totalBackEdges,
      child_of_reciprocals_to_add: totalChildOfAdds,
      false_parent_claims_to_remove: totalFalseClaimsRemoved,
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
      // Tier 2a: add missing Parent-of back-edges last so they land at
      // the end of a Parent of section that's already been reshaped by
      // 1.5 (demotes may have added bullets earlier in the section).
      if (plan.add_parent_of_bullets.length > 0) {
        const dedup = Array.from(new Set(plan.add_parent_of_bullets));
        const added = addParentOfBullets(content, dedup);
        if (added) content = added.content;
      }
      // Tier 2b (add-side): add a single canonical parent to Child of.
      // Only fires on docs that had 0 declared parents at plan time.
      if (plan.add_child_of_bullet !== null) {
        const added = addChildOfBullet(content, plan.add_child_of_bullet);
        if (added) content = added.content;
      }
      // Tier 2b (remove-side): drop false Parent of claims.
      if (plan.remove_parent_of_bullets.length > 0) {
        const dropSet = new Set(plan.remove_parent_of_bullets.map((t) => t.toLowerCase()));
        const removed = removeParentOfBullets(content, dropSet);
        if (removed) content = removed.content;
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
    back_edges_to_add: totalBackEdges,
    child_of_reciprocals_to_add: totalChildOfAdds,
    false_parent_claims_to_remove: totalFalseClaimsRemoved,
    applied,
    failed,
    remaining_warnings_estimate: remainingCount,
  });
}
