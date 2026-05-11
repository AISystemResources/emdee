import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ToolContext } from "./types.js";

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

interface SectionLoc {
  heading: string;
  headingLineIdx: number;
  bodyStartLineIdx: number;
  bodyEndLineIdx: number; // exclusive
}

const FENCE_RE = /^\s*(?:```|~~~)/;
const H2_RE = /^##\s+(.+?)\s*$/;

function parseSections(content: string): SectionLoc[] {
  const lines = content.split("\n");
  const sections: SectionLoc[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = lines[i].match(H2_RE);
    if (!m) continue;
    if (sections.length > 0) {
      sections[sections.length - 1].bodyEndLineIdx = i;
    }
    sections.push({
      heading: m[1].trim(),
      headingLineIdx: i,
      bodyStartLineIdx: i + 1,
      bodyEndLineIdx: lines.length,
    });
  }
  return sections;
}

function simpleDiff(before: string, after: string): string {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  let commonPrefix = 0;
  while (
    commonPrefix < beforeLines.length &&
    commonPrefix < afterLines.length &&
    beforeLines[commonPrefix] === afterLines[commonPrefix]
  ) {
    commonPrefix++;
  }
  let commonSuffix = 0;
  while (
    commonSuffix < beforeLines.length - commonPrefix &&
    commonSuffix < afterLines.length - commonPrefix &&
    beforeLines[beforeLines.length - 1 - commonSuffix] === afterLines[afterLines.length - 1 - commonSuffix]
  ) {
    commonSuffix++;
  }
  const out: string[] = [];
  out.push(`--- before (${beforeLines.length} lines)`);
  out.push(`+++ after  (${afterLines.length} lines)`);
  if (commonPrefix > 0) out.push(`  … ${commonPrefix} unchanged …`);
  for (let i = commonPrefix; i < beforeLines.length - commonSuffix; i++) {
    out.push(`- ${beforeLines[i]}`);
  }
  for (let i = commonPrefix; i < afterLines.length - commonSuffix; i++) {
    out.push(`+ ${afterLines[i]}`);
  }
  if (commonSuffix > 0) out.push(`  … ${commonSuffix} unchanged …`);
  return out.join("\n");
}

function safeResolve(docsDir: string, rel: string): string {
  const resolved = path.resolve(docsDir, rel);
  if (!resolved.startsWith(docsDir)) throw new Error("path escapes docs directory");
  return resolved;
}

export async function writeDocPreview(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const file = safeResolve(ctx.docsDir, String(args.path));
  const newContent = String(args.content ?? "");
  let before = "";
  try {
    before = await readFile(file, "utf8");
  } catch {
    return json({
      action: "create",
      path: args.path,
      new_size_lines: newContent.split("\n").length,
    });
  }
  if (before === newContent) {
    return json({ action: "no_change", path: args.path });
  }
  const beforeSections = parseSections(before).map((s) => s.heading);
  const afterSections = parseSections(newContent).map((s) => s.heading);
  const removed = beforeSections.filter((h) => !afterSections.includes(h));
  return json({
    action: "replace",
    path: args.path,
    sections_removed: removed,
    sections_before: beforeSections,
    sections_after: afterSections,
    diff: simpleDiff(before, newContent),
  });
}
