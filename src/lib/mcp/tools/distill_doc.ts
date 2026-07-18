import { createHash } from "node:crypto";
import { validatePath, loadVaultIndex } from "./vault";
import type { ToolContext } from "./types";
import type { DocNode } from "../../../core/indexer";
import { validateArgs } from "./validate_args";

const ARG_SPEC = { allowed: ["path"], required: ["path"] } as const;

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

const FENCE_RE = /^\s*(?:```|~~~)/;
const H2_RE = /^##\s+(.+?)\s*$/;
const H3_RE = /^###\s+(.+?)\s*$/;
const H1_RE = /^#\s+(.+?)\s*$/;

interface SectionLoc {
  heading: string;
  level: 2 | 3;
  start_line: number;
  end_line: number;
  body_verbatim: string;
  content_hash: string;
  char_count: number;
}

/**
 * Walk the source doc and emit a flat list of H2 + H3 sections — both are
 * extraction boundaries for distill_doc. The body of each section runs up
 * to the next heading of equal or shallower depth.
 */
function parseSectionsForDistill(content: string): SectionLoc[] {
  const lines = content.split("\n");
  const headings: Array<{ heading: string; level: 2 | 3; line: number }> = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    const h2 = lines[i].match(H2_RE);
    if (h2) { headings.push({ heading: h2[1].trim(), level: 2, line: i }); continue; }
    const h3 = lines[i].match(H3_RE);
    if (h3) headings.push({ heading: h3[1].trim(), level: 3, line: i });
  }

  const out: SectionLoc[] = [];
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    // End the body when we hit the next heading of equal-or-shallower depth.
    let end = lines.length;
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].level <= h.level) { end = headings[j].line; break; }
    }
    const body_verbatim = lines.slice(h.line + 1, end).join("\n").replace(/^\s*\n+/, "").replace(/\n+\s*$/, "");
    out.push({
      heading: h.heading,
      level: h.level,
      start_line: h.line,
      end_line: end,
      body_verbatim,
      content_hash: hashBody(body_verbatim),
      char_count: body_verbatim.length,
    });
  }
  return out;
}

function hashBody(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex").slice(0, 16);
}

/**
 * Pull a named H2 section's body out of a doc. Used to extract the
 * BRAIN/PATTERN/INFO rubric content from the live docs so the distill
 * semantics stay in sync with whatever the canonical filters say today.
 * Returns null when the doc lacks that section.
 */
function extractH2Section(content: string, headingLower: string): string | null {
  const lines = content.split("\n");
  let inFence = false;
  let startBody = -1;
  let endBody = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = lines[i].match(H2_RE);
    if (!m) continue;
    const h = m[1].trim().toLowerCase();
    if (startBody === -1 && h === headingLower) {
      startBody = i + 1;
      continue;
    }
    if (startBody !== -1) { endBody = i; break; }
  }
  if (startBody === -1) return null;
  return lines.slice(startBody, endBody).join("\n").trim();
}

/**
 * Extract a doc's H1 + blockquote summary (preamble region). Used to
 * convey the BRAIN / PROJECTS — PATTERN charter alongside the CONTEXT
 * section — together they form the rubric.
 */
function extractPreambleSummary(content: string): string {
  const lines = content.split("\n");
  let inFence = false;
  let h1Idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (H1_RE.test(lines[i])) { h1Idx = i; break; }
  }
  if (h1Idx === -1) return "";

  let firstH2Idx = lines.length;
  inFence = false;
  for (let i = h1Idx + 1; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (H2_RE.test(lines[i])) { firstH2Idx = i; break; }
  }
  return lines.slice(h1Idx, firstH2Idx).join("\n").trim();
}

function findByTitle(docs: DocNode[], title: string): DocNode | undefined {
  const target = title.toLowerCase();
  return docs.find((d) => d.title.toLowerCase() === target);
}

const PLAN_INSTRUCTIONS = `You are constructing a distillation plan for a notes doc. The plan will be reviewed by a human, then executed via the \`split_doc\` MCP tool which atomically rewrites the source and creates the new extract docs.

STRICT RULES — failure to follow these breaks the trust contract with the user, who exports these notes to other people:

1. **Verbatim body.** Every extract's \`body_verbatim\` field MUST be a copy-paste of the exact bytes from \`source.sections[i].body_verbatim\`. Do NOT reword, paraphrase, polish, summarize, or "improve" the prose. Same em-dashes, same code fences, same tables, same trailing whitespace. If you can't extract a concept without rewriting it to stand alone, DO NOT extract — add it to \`flagged_for_manual_split\` instead.

2. **Title and summary are the only things you author.** The H1 title and the \`> blockquote\` summary on the new doc are the only LLM-authored strings. Mark both clearly in the plan's \`notes\` field as "review: LLM-drafted." Everything else is the user's own words.

3. **Section-level only.** Only propose extractions at H2 or H3 section boundaries (matching exactly one \`source.sections[i].heading\`). If a concept sits mid-paragraph or spans multiple sub-paragraphs without a clean heading, add it to \`flagged_for_manual_split\` with the reason.

4. **Idempotency.** For every extract, check \`vault_context.existing_titles\` (case-insensitive). If the title already exists, set \`already_exists: { path: "<existing-path>" }\` and DO NOT propose body_verbatim for that extract — the source will simply get a wiki-link stub pointing at the existing doc instead.

5. **Branch placement is a hint, not a decision.** The user makes the final call. Provide your best guess in \`suggested_child_of\` and \`suggested_associated_with\` using the rubrics from \`vault_context\`. Explain your reasoning briefly in \`notes\`.

6. **Source rewrite.** Construct \`source_rewrite_summary\` describing what the source doc will look like after extraction — typically the narrative scaffolding stays, the extracted sections become single-line wiki-link bullets. The actual rewritten content will be assembled by the executor (you or the user) when calling \`split_doc\`.

7. **Confidence scoring.** \`high\` = clean section boundary, clear concept, obvious branch fit. \`medium\` = readable but judgment call on title or branch. \`low\` = the section feels extractable but you're unsure — flag your doubt in \`notes\` for the reviewer.

8. **Don't extract everything.** Narrative content, session-specific observations, personal AHAs, and "(to be expanded)" stubs should usually stay in the source — they're not standalone concepts. Surface them in \`keep_in_source_headings\`. The goal is to extract knowledge POINTS that other docs can wiki-link to, not to evacuate the source.

Now: read \`source\` and \`vault_context\`, then produce a plan in the shape of \`plan_template.schema_hint\`.`;

const EXAMPLE_EXTRACT = {
  title: "PAS Formula",
  summary: "> Problem → Agitate → Solution. The emotional arc that great copy follows: name the problem, twist the knife, then ride in with the solution. Makes the prospect feel the pain before offering the relief.",
  suggested_path: "concepts/PAS-FORMULA.md",
  suggested_child_of: ["[[PROJECTS — PATTERN]]"],
  suggested_associated_with: ["[[GBI_Day4]]", "[[GBI]]"],
  source_section_heading: "#3 — How to Write the Body: The PAS Formula",
  body_verbatim: "<copy-paste of source.sections[i].body_verbatim verbatim — same bytes, do not reword>",
  confidence: "high",
  notes: "review: LLM-drafted title + summary. Branch placement: PROJECTS — PATTERN since this is a cross-instance technical pattern for copywriting. Associated with both the day note (GBI_Day4) and the event itself (GBI).",
};

const SCHEMA_HINT = JSON.stringify(
  {
    source_path: "string — same as input path",
    source_rewrite_summary: "string — one paragraph describing the post-extraction source state",
    extracts: [
      {
        title: "string",
        summary: "string — must start with `> `",
        suggested_path: "string — vault-relative, ends in .md",
        suggested_child_of: ["array of `[[Title]]` wiki-link strings"],
        suggested_associated_with: ["array of `[[Title]]` wiki-link strings"],
        source_section_heading: "string — exact match to source.sections[i].heading",
        body_verbatim: "string — VERBATIM from source.sections[i].body_verbatim",
        confidence: "high | medium | low",
        notes: "string — reasoning, flags for review",
        "already_exists?": { path: "string — set ONLY if title already exists in vault" },
      },
    ],
    keep_in_source_headings: ["array of section headings to leave in the source"],
    flagged_for_manual_split: [
      { section_heading: "string", reason: "string" },
    ],
  },
  null,
  2
);

/**
 * Read-only intake helper for splitting a notes doc into knowledge nodes.
 *
 * Returns everything the calling LLM needs to construct a defensible
 * split plan without paying for vault lookups one-tool-call-at-a-time:
 * the source content with section boundaries marked, the existing vault
 * title set (collision check), the BRAIN / PROJECTS — PATTERN / LEARNINGS
 * rubrics quoted from the live canonical docs, and a plan template.
 *
 * Does NOT make any LLM calls server-side and does NOT write anything.
 * The calling agent (Claude Chat, ChatGPT, Doubao — whichever) constructs
 * the plan in its response. The user reviews. Then split_doc executes.
 */
export async function distillDoc(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const argErr = validateArgs(args, ARG_SPEC);
  if (argErr) return json(argErr);
  const rel = String(args.path);
  validatePath(rel);

  const index = await loadVaultIndex(ctx);
  const source = index.docs.find((d) => d.path === rel);
  if (!source) return json({ error: "doc_not_found", path: rel });

  const sections = parseSectionsForDistill(source.content);
  const existing_titles = index.docs.map((d) => d.title);

  // Pull the rubrics from the canonical docs by title (not path) so the
  // distillation semantics survive any future renames of those docs.
  const brain = findByTitle(index.docs, "BRAIN");
  const projectsPattern = findByTitle(index.docs, "PROJECTS — PATTERN");

  const brain_charter = brain
    ? `${extractPreambleSummary(brain.content)}\n\n${extractH2Section(brain.content, "context") ?? ""}`.trim()
    : "(BRAIN.md not found — falling back: BRAIN holds cross-domain personal operating principles that pass operating-principle / cross-context / actionable.)";

  const projects_pattern_rules = projectsPattern
    ? `${extractPreambleSummary(projectsPattern.content)}\n\n${extractH2Section(projectsPattern.content, "context") ?? ""}`.trim()
    : "(PROJECTS — PATTERN doc not found — falling back: cross-project technical/business patterns observed in ≥2 projects.)";

  const learnings_filter = "(three-test filter: reusable, non-obvious in retrospect, has a directive.)";

  // Branches that currently host a PATTERN.md — informs the calling LLM
  // about where else extracts could go beyond PROJECTS — PATTERN.
  const branches_with_pattern = index.docs
    .filter((d) => /(^|\/)PATTERN\.md$/.test(d.path) && d.path !== "PATTERN.md")
    .map((d) => ({
      branch: d.path.replace(/\/PATTERN\.md$/, "") || "(root)",
      pattern_path: d.path,
    }));

  return json({
    source: {
      path: source.path,
      title: source.title,
      h1: source.title,
      content: source.content,
      sections,
    },
    vault_context: {
      existing_titles,
      branches_with_pattern,
      brain_charter,
      projects_pattern_rules,
      learnings_filter,
    },
    plan_template: {
      instructions: PLAN_INSTRUCTIONS,
      example_extract: EXAMPLE_EXTRACT,
      schema_hint: SCHEMA_HINT,
    },
  });
}
