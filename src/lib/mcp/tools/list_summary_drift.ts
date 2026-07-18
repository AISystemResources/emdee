// SPRINT-081: list docs whose body has changed since their summary was
// last authored — the working set for the summariser workflow.
//
// Cloud mode: reads the vault_files cache, computes the current content
// hash per row in-app, keeps rows where the snapshot doesn't match (or is
// NULL, meaning never baselined post-migration). Local mode has no
// persistence — every doc is returned as a candidate.
//
// Response is intentionally minimal: path + current summary + drift
// reason. `format: "text"` returns newline-delimited paths only.

import { loadVaultIndex } from "./vault";
import { hashBody } from "./sections";
import { adminClient } from "../../supabase/admin";
import { deriveSummary } from "../../../core/indexer";
import type { ToolContext } from "./types";

const CACHE_TABLE = "vault_files";

interface DriftCandidate {
  path: string;
  current_summary: string;
  reason: "never_baselined" | "body_drifted";
}

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

async function candidatesLocal(ctx: Extract<ToolContext, { mode: "local" }>): Promise<DriftCandidate[]> {
  const idx = await loadVaultIndex(ctx);
  return idx.docs.map((d) => ({
    path: d.path,
    current_summary: d.summary ?? "",
    reason: "never_baselined" as const,
  }));
}

async function candidatesCloud(ctx: Extract<ToolContext, { mode: "cloud" }>): Promise<DriftCandidate[]> {
  // HARD RULE 6: PostgREST caps `.select()` at 1000 rows server-side, so
  // any vault > 1000 docs would silently truncate without pagination.
  // Explicit .range() loop until a short page comes back.
  const admin = adminClient();
  const PAGE = 1000;
  const out: DriftCandidate[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await admin
      .from(CACHE_TABLE)
      .select("file_path, content, content_hash_at_summary_write")
      .eq("namespace", ctx.userId)
      .order("file_path", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`list_summary_drift query failed: ${error.message}`);
    const rows = data ?? [];
    for (const row of rows) {
      const content = (row.content as string) ?? "";
      const stored = (row.content_hash_at_summary_write as string | null) ?? null;
      const now = hashBody(content);
      if (stored === null) {
        out.push({ path: row.file_path as string, current_summary: deriveSummary(content), reason: "never_baselined" });
      } else if (stored !== now) {
        out.push({ path: row.file_path as string, current_summary: deriveSummary(content), reason: "body_drifted" });
      }
    }
    if (rows.length < PAGE) break;
  }
  return out;
}

export async function listSummaryDrift(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const prefix = typeof args.prefix === "string" ? args.prefix : "";
  const limit = Math.max(1, Number(args.limit ?? 20) | 0);
  const offset = Math.max(0, Number(args.offset ?? 0) | 0);

  const all = ctx.mode === "local" ? await candidatesLocal(ctx) : await candidatesCloud(ctx);
  const filtered = all
    .filter((c) => !prefix || c.path.startsWith(prefix))
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(offset, offset + limit);

  if (args.format === "text") {
    return text(filtered.map((c) => c.path).join("\n"));
  }
  return json({
    total_before_slice: all.filter((c) => !prefix || c.path.startsWith(prefix)).length,
    returned: filtered.length,
    offset,
    limit,
    candidates: filtered,
  });
}
