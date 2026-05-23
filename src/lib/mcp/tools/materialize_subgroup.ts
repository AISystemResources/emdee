import path from "node:path";
import { validatePath, readVaultFile, writeVaultFile, loadVaultIndex } from "./vault";
import { resolveWikiLink } from "../../../core/resolveLink";
import type { ToolContext } from "./types";

const H1_RE = /^#\s+(.+?)\s*$/m;
const H2_RE = /^##\s+(.+?)\s*$/;
const H3_RE = /^###\s+(.+?)\s*$/;
const BULLET_RE = /^\s*[-*]\s+/;
const WIKI_LINK_RE = /\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]/;

function deriveTitle(content: string, fallbackPath: string): string {
  const m = content.match(H1_RE);
  if (m) return m[1].trim();
  return path.basename(fallbackPath, ".md");
}

function sanitizeFilename(title: string): string {
  // Match the rename_doc convention but also strip the em-dash since
  // Supabase Storage rejects it. Replace ` — ` with `-`, then strip any
  // remaining unsafe chars.
  return title.replace(/\s*—\s*/g, "-").replace(/[/\\]/g, "_");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface SubgroupExtract {
  bulletLines: string[];
  bulletTitles: string[];
  // Line indices (inclusive) of the entire subgroup region: from the H3
  // line through the last bullet of the subgroup. Used for surgical
  // replacement in the source.
  startLineIdx: number;
  endLineIdx: number;
}

/**
 * Walk source content, locate the named H3 subgroup inside `## Parent of`,
 * extract its bullets, and return the line indices of the subgroup region
 * so we can splice in a single replacement bullet later.
 */
function extractSubgroup(content: string, subgroupHeading: string): SubgroupExtract | null {
  const lines = content.split("\n");
  const targetLc = subgroupHeading.trim().toLowerCase();
  let inFence = false;
  let inParentOf = false;
  let h3Idx = -1;
  let endIdx = -1;
  const bulletLines: string[] = [];
  const bulletTitles: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(?:```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;

    const h2 = line.match(H2_RE);
    if (h2) {
      if (h3Idx !== -1) {
        // Hit the next H2 after collecting our subgroup — done.
        endIdx = i - 1;
        break;
      }
      inParentOf = h2[1].trim().toLowerCase() === "parent of";
      continue;
    }
    if (!inParentOf) continue;

    const h3 = line.match(H3_RE);
    if (h3) {
      if (h3Idx !== -1) {
        // Hit the next H3 within Parent of — our subgroup ends here.
        endIdx = i - 1;
        break;
      }
      if (h3[1].trim().toLowerCase() === targetLc) {
        h3Idx = i;
      }
      continue;
    }

    if (h3Idx === -1) continue;
    if (BULLET_RE.test(line)) {
      const leading = line.replace(BULLET_RE, "").match(WIKI_LINK_RE);
      if (leading) {
        bulletLines.push(line);
        bulletTitles.push(leading[1].trim());
      }
    }
  }

  if (h3Idx === -1) return null;
  if (endIdx === -1) endIdx = lines.length - 1;
  // Trim trailing blank lines from the subgroup region so the splice
  // doesn't leave double-blank gaps.
  while (endIdx > h3Idx && lines[endIdx].trim() === "") endIdx--;
  return { bulletLines, bulletTitles, startLineIdx: h3Idx, endLineIdx: endIdx };
}

/**
 * Replace the subgroup region (H3 + its bullets) with a single bullet
 * pointing at the new intermediate doc.
 */
function rewriteSourceParentOf(content: string, sub: SubgroupExtract, newDocTitle: string): string {
  const lines = content.split("\n");
  const replacement = `* [[${newDocTitle}]]`;
  const before = lines.slice(0, sub.startLineIdx);
  const after = lines.slice(sub.endLineIdx + 1);
  return [...before, replacement, ...after].join("\n");
}

/**
 * Rewrite a child doc's `## Child of` bullet from the old parent's title
 * to the new intermediate's title. Preserves any `|alias` suffix and any
 * trailing prose on the bullet. Only touches the Child of section.
 */
function rewriteChildOf(content: string, oldTitle: string, newTitle: string): { content: string; changed: boolean } {
  const lines = content.split("\n");
  const out: string[] = [];
  let inFence = false;
  let inChildOf = false;
  let changed = false;
  const re = new RegExp(`\\[\\[${escapeRegex(oldTitle)}(\\|[^\\]]+)?\\]\\]`, "gi");
  for (const line of lines) {
    if (/^\s*(?:```|~~~)/.test(line)) { inFence = !inFence; out.push(line); continue; }
    if (inFence) { out.push(line); continue; }
    const h2 = line.match(H2_RE);
    if (h2) {
      inChildOf = h2[1].trim().toLowerCase() === "child of";
      out.push(line);
      continue;
    }
    if (!inChildOf) { out.push(line); continue; }
    const next = line.replace(re, (_m, alias: string | undefined) => {
      changed = true;
      return `[[${newTitle}${alias ?? ""}]]`;
    });
    out.push(next);
  }
  return { content: out.join("\n"), changed };
}

function buildIntermediateDoc(title: string, summary: string, sourceTitle: string, bulletLines: string[]): string {
  const summaryLine = summary.trim() || `Intermediate node grouping the ${bulletLines.length} concepts originally listed under "${title}" in [[${sourceTitle}]].`;
  return [
    `# ${title}`,
    "",
    `> ${summaryLine}`,
    "",
    "## Child of",
    "",
    `* [[${sourceTitle}]]`,
    "",
    "## Parent of",
    "",
    ...bulletLines,
    "",
  ].join("\n");
}

/**
 * Promote an H3 subgroup inside a doc's `## Parent of` to a real
 * intermediate parent node. Atomically:
 *   - creates the new intermediate doc with the subgroup's bullets as
 *     its own `## Parent of`
 *   - rewrites the source's `## Parent of` so the H3 region is replaced
 *     by a single bullet pointing at the new intermediate
 *   - rewires each child's `## Child of` from the source's title to the
 *     new intermediate's title (single-parent convention preserved)
 *
 * Used when a parent doc has accumulated too many children and the user
 * already grouped them semantically with H3 sub-headings — this turns
 * the visual grouping into a structural one. Detection lives in lint
 * (`subgroup_materialization_candidate`).
 */
export async function materializeSubgroup(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const sourcePath = String(args.source_path ?? "");
  const subgroupHeading = String(args.subgroup_heading ?? "");
  const summary = args.summary !== undefined ? String(args.summary) : "";

  if (!sourcePath) return json({ error: "source_path required" });
  if (!subgroupHeading) return json({ error: "subgroup_heading required" });
  validatePath(sourcePath);

  const sourceContent = await readVaultFile(ctx, sourcePath);
  if (sourceContent === null) return json({ error: "source_not_found", path: sourcePath });

  const sourceTitle = deriveTitle(sourceContent, sourcePath);

  const newDocTitle = args.new_doc_title
    ? String(args.new_doc_title).trim()
    : `${sourceTitle} — ${subgroupHeading.trim()}`;
  const newDocPath = args.new_doc_path
    ? String(args.new_doc_path)
    : (() => {
        const dir = path.dirname(sourcePath);
        const fname = `${sanitizeFilename(newDocTitle)}.md`;
        return dir === "." ? fname : `${dir}/${fname}`;
      })();
  validatePath(newDocPath);

  const sub = extractSubgroup(sourceContent, subgroupHeading);
  if (!sub) return json({ error: "subgroup_not_found", heading: subgroupHeading });
  if (sub.bulletTitles.length === 0) return json({ error: "subgroup_empty", heading: subgroupHeading });

  const index = await loadVaultIndex(ctx);

  // Pre-flight: destination path must be free.
  if (index.docs.some((d) => d.path === newDocPath)) {
    return json({ error: "new_doc_path_exists", path: newDocPath });
  }
  // Pre-flight: title can't collide with another doc.
  const titleConflict = index.docs.find(
    (d) => d.path !== sourcePath && d.title.toLowerCase() === newDocTitle.toLowerCase()
  );
  if (titleConflict) {
    return json({ error: "title_collision", path: titleConflict.path, title: titleConflict.title });
  }

  // Resolve every bullet to a child doc path so we can rewrite their
  // `## Child of`. Unresolved bullets are reported but don't block —
  // they may be forward-references to docs not yet created.
  const childDocs: Array<{ title: string; path: string }> = [];
  const unresolved: string[] = [];
  for (const t of sub.bulletTitles) {
    const resolved = resolveWikiLink(index, t, sourcePath);
    if (resolved) childDocs.push({ title: t, path: resolved.path });
    else unresolved.push(t);
  }

  const newDocContent = buildIntermediateDoc(newDocTitle, summary, sourceTitle, sub.bulletLines);
  const newSourceContent = rewriteSourceParentOf(sourceContent, sub, newDocTitle);

  // Stage child rewrites in memory so we can validate before any writes.
  const childUpdates: Array<{ path: string; content: string }> = [];
  for (const c of childDocs) {
    const content = await readVaultFile(ctx, c.path);
    if (content === null) continue;
    const result = rewriteChildOf(content, sourceTitle, newDocTitle);
    if (result.changed) childUpdates.push({ path: c.path, content: result.content });
  }

  // Execute: write the intermediate first (idempotent on retry — the
  // existence check catches the destination collision), then the source
  // rewrite, then each child rewrite.
  await writeVaultFile(ctx, newDocPath, newDocContent);
  await writeVaultFile(ctx, sourcePath, newSourceContent);
  for (const u of childUpdates) {
    await writeVaultFile(ctx, u.path, u.content);
  }

  return json({
    ok: true,
    new_doc_path: newDocPath,
    new_doc_title: newDocTitle,
    bullets_promoted: sub.bulletTitles.length,
    children_rewired: childUpdates.length,
    unresolved_bullets: unresolved,
  });
}

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}
