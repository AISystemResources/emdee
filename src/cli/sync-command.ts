// SPRINT-142 (SIG-032 Phase 3 chunk E): one-shot bidirectional sync.
//
// Uses SPRINT-141 version-guards as the write-safety primitive. Reads a
// per-vault manifest at <docsDir>/.emdee/sync-manifest.json to detect
// which docs changed on each side since last sync. Same-section conflicts
// preserve the local draft under .emdee/conflicts/ and adopt the cloud
// version locally.
//
// Not a daemon. Not auto-triggered. User runs `emdee sync` manually or
// wires it into cron / a shell hook. The invisible variant (fs-watcher,
// pull-on-focus) is a follow-up sprint.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { callTool, unwrapText } from "./remote-client";
import { loadCreds, NeedsLoginError } from "./auth";
import { localToolContext } from "../lib/mcp/tools/context";
import { LOCAL_NAMESPACE } from "../lib/mcp/tools/types";
import { writeVaultFile } from "../lib/mcp/tools/vault";
import { hashBody } from "../lib/mcp/tools/sections";
import type { ToolContext } from "../lib/mcp/tools/types";

interface ManifestEntry {
  local_hash: string; // hash of local content at last successful sync
  cloud_hash: string; // hash of cloud content at last successful sync
  synced_at: string;  // ISO timestamp
}
interface Manifest { [path: string]: ManifestEntry }

type Action =
  | { kind: "skip"; reason: string }
  | { kind: "push"; localHash: string; expectedCloudHash: string | null }
  | { kind: "pull"; cloudHash: string }
  | { kind: "conflict"; localHash: string; cloudHash: string }
  | { kind: "delete_local_missing"; note: string }
  | { kind: "delete_cloud_missing"; note: string };

interface PlannedAction { path: string; action: Action }

export interface SyncOptions {
  docsDir: string;
  dryRun?: boolean;
}

export interface SyncSummary {
  pushed: string[];
  pulled: string[];
  conflicts: string[];
  skipped: number;
  warnings: string[];
  dry_run: boolean;
}

function manifestPath(docsDir: string): string {
  return path.join(docsDir, ".emdee", "sync-manifest.json");
}
function conflictsDir(docsDir: string): string {
  return path.join(docsDir, ".emdee", "conflicts");
}

async function readManifest(docsDir: string): Promise<Manifest> {
  try {
    const raw = await readFile(manifestPath(docsDir), "utf8");
    return JSON.parse(raw) as Manifest;
  } catch {
    return {};
  }
}
async function writeManifest(docsDir: string, m: Manifest): Promise<void> {
  await mkdir(path.dirname(manifestPath(docsDir)), { recursive: true });
  await writeFile(manifestPath(docsDir), JSON.stringify(m, null, 2), "utf8");
}

/**
 * Fetch { path -> current cloud content_hash } for every doc in the cloud vault.
 * Uses list_docs (compact — path only) then batch_get_doc for envelopes.
 * BATCH_SIZE keeps each round-trip small; batch_get_doc caps at ~50.
 */
async function enumerateCloud(): Promise<Map<string, { content_hash: string }>> {
  const listRaw = await callTool("list_docs", { format: "compact" });
  const listText = unwrapText(listRaw);
  const listParsed = JSON.parse(listText) as Array<{ path: string; title?: string }>;
  const paths = listParsed.map((d) => d.path);

  const out = new Map<string, { content_hash: string }>();
  const BATCH = 50;
  for (let i = 0; i < paths.length; i += BATCH) {
    const chunk = paths.slice(i, i + BATCH);
    const raw = await callTool("batch_get_doc", { paths: chunk });
    const text = unwrapText(raw);
    for (const [p, hash] of parseBatchGetHashes(text)) {
      out.set(p, { content_hash: hash });
    }
  }
  return out;
}

/**
 * SPRINT-142F: batch_get_doc returns `{ count, results: [...] }`, not a bare
 * array. The prior code cast to Array and blew up with "parsed is not
 * iterable" on the first cloud enumeration. Exported so the regression
 * spec can pin the exact envelope shape.
 */
export function parseBatchGetHashes(rawText: string): Map<string, string> {
  const out = new Map<string, string>();
  const parsed = JSON.parse(rawText) as {
    count?: number;
    results?: Array<{ path: string; doc_content_hash?: string }>;
    error?: string;
  };
  if (parsed.error) throw new Error(`batch_get_doc: ${parsed.error}`);
  for (const d of parsed.results ?? []) {
    if (d.doc_content_hash) out.set(d.path, d.doc_content_hash);
  }
  return out;
}

/** Fetch full content for one cloud doc. */
async function fetchCloudContent(p: string): Promise<{ content: string; hash: string } | null> {
  const raw = await callTool("get_doc", { path: p, full: true });
  const text = unwrapText(raw);
  const parsed = JSON.parse(text) as { content?: string; doc_content_hash?: string; error?: string };
  if (parsed.error || !parsed.content || !parsed.doc_content_hash) return null;
  return { content: parsed.content, hash: parsed.doc_content_hash };
}

/** Push a local doc up. write_doc handles both create + overwrite. */
async function pushLocalDoc(
  p: string,
  content: string,
  expectedCloudHash: string | null,
): Promise<void> {
  const args: Record<string, unknown> = { path: p, content };
  if (expectedCloudHash) args.expected_content_hash = expectedCloudHash;
  await callTool("write_doc", args);
}

async function preserveLocalDraft(docsDir: string, p: string, localContent: string): Promise<string> {
  await mkdir(conflictsDir(docsDir), { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const flatName = p.replace(/[/\\]/g, "__");
  const dest = path.join(conflictsDir(docsDir), `${flatName}-${ts}.md`);
  await writeFile(dest, localContent, "utf8");
  return dest;
}

async function applyPullLocally(ctx: ToolContext, p: string, cloudContent: string): Promise<void> {
  // writeVaultFile writes FS + db.putFile + runs syncDocEdges so the
  // local index stays coherent with the pulled content.
  await writeVaultFile(ctx, p, cloudContent);
}

/** Core planner — returns actions per path, no writes. */
export function planActions(
  local: Map<string, string>, // path -> current hash
  cloud: Map<string, string>, // path -> current hash
  manifest: Manifest,
): PlannedAction[] {
  const allPaths = new Set<string>([...local.keys(), ...cloud.keys(), ...Object.keys(manifest)]);
  const plan: PlannedAction[] = [];

  for (const p of allPaths) {
    const localHash = local.get(p) ?? null;
    const cloudHash = cloud.get(p) ?? null;
    const m = manifest[p];

    // Not previously synced.
    if (!m) {
      if (localHash && cloudHash) {
        if (localHash === cloudHash) plan.push({ path: p, action: { kind: "skip", reason: "identical_first_sync" } });
        else plan.push({ path: p, action: { kind: "conflict", localHash, cloudHash } });
        continue;
      }
      if (localHash && !cloudHash) {
        plan.push({ path: p, action: { kind: "push", localHash, expectedCloudHash: null } });
        continue;
      }
      if (!localHash && cloudHash) {
        plan.push({ path: p, action: { kind: "pull", cloudHash } });
        continue;
      }
      // Neither side has it. Manifest is stale w.r.t. a doc that
      // vanished from both — first-cut just skips.
      plan.push({ path: p, action: { kind: "skip", reason: "vanished_both" } });
      continue;
    }

    // Previously synced.
    const localChanged = localHash !== m.local_hash;
    const cloudChanged = cloudHash !== m.cloud_hash;

    if (!localChanged && !cloudChanged) {
      plan.push({ path: p, action: { kind: "skip", reason: "unchanged" } });
      continue;
    }
    // Deletions: first-cut skips with a warning.
    if (localHash === null) {
      plan.push({ path: p, action: { kind: "delete_local_missing", note: "doc missing locally; delete-propagation deferred" } });
      continue;
    }
    if (cloudHash === null) {
      plan.push({ path: p, action: { kind: "delete_cloud_missing", note: "doc missing on cloud; delete-propagation deferred" } });
      continue;
    }
    if (localChanged && !cloudChanged) {
      plan.push({ path: p, action: { kind: "push", localHash, expectedCloudHash: cloudHash } });
      continue;
    }
    if (cloudChanged && !localChanged) {
      plan.push({ path: p, action: { kind: "pull", cloudHash } });
      continue;
    }
    // Both changed → conflict.
    plan.push({ path: p, action: { kind: "conflict", localHash, cloudHash } });
  }

  return plan;
}

export async function runSync(opts: SyncOptions): Promise<SyncSummary> {
  const creds = await loadCreds();
  if (!creds) throw new NeedsLoginError("emdee sync requires cloud login. Run `emdee login`.");

  const docsDir = path.resolve(opts.docsDir);
  if (!existsSync(docsDir)) throw new Error(`docs directory not found: ${docsDir}`);

  const ctx = localToolContext(docsDir);
  const dryRun = opts.dryRun === true;

  // Enumerate both sides.
  const localFiles = await ctx.db.listFiles(LOCAL_NAMESPACE);
  const local = new Map<string, string>();
  const localContent = new Map<string, string>();
  for (const f of localFiles) {
    const c = f.content ?? "";
    local.set(f.file_path, hashBody(c));
    localContent.set(f.file_path, c);
  }

  const cloud = await enumerateCloud();
  const cloudHashes = new Map<string, string>();
  for (const [p, v] of cloud) cloudHashes.set(p, v.content_hash);

  const manifest = await readManifest(docsDir);
  const plan = planActions(local, cloudHashes, manifest);

  const summary: SyncSummary = { pushed: [], pulled: [], conflicts: [], skipped: 0, warnings: [], dry_run: dryRun };
  const nextManifest: Manifest = { ...manifest };
  const now = new Date().toISOString();

  for (const item of plan) {
    const { path: p, action } = item;
    switch (action.kind) {
      case "skip":
        summary.skipped++;
        break;

      case "push": {
        if (dryRun) {
          summary.pushed.push(p);
          break;
        }
        const content = localContent.get(p)!;
        try {
          await pushLocalDoc(p, content, action.expectedCloudHash);
          nextManifest[p] = { local_hash: action.localHash, cloud_hash: action.localHash, synced_at: now };
          summary.pushed.push(p);
        } catch (e) {
          summary.warnings.push(`push failed for ${p}: ${(e as Error).message}`);
        }
        break;
      }

      case "pull": {
        if (dryRun) {
          summary.pulled.push(p);
          break;
        }
        const fetched = await fetchCloudContent(p);
        if (!fetched) {
          summary.warnings.push(`pull failed for ${p}: cloud fetch returned null`);
          break;
        }
        await applyPullLocally(ctx, p, fetched.content);
        nextManifest[p] = { local_hash: fetched.hash, cloud_hash: fetched.hash, synced_at: now };
        summary.pulled.push(p);
        break;
      }

      case "conflict": {
        if (dryRun) {
          summary.conflicts.push(p);
          break;
        }
        const localBody = localContent.get(p) ?? "";
        const draftPath = await preserveLocalDraft(docsDir, p, localBody);
        const fetched = await fetchCloudContent(p);
        if (!fetched) {
          summary.warnings.push(`conflict: cloud fetch failed for ${p} — local draft at ${draftPath}, local content left in place`);
          break;
        }
        await applyPullLocally(ctx, p, fetched.content);
        nextManifest[p] = { local_hash: fetched.hash, cloud_hash: fetched.hash, synced_at: now };
        summary.conflicts.push(p);
        summary.warnings.push(`CONFLICT: ${p} — local draft preserved at ${path.relative(docsDir, draftPath)}, cloud version adopted`);
        break;
      }

      case "delete_local_missing":
      case "delete_cloud_missing":
        summary.warnings.push(`skipped (delete-propagation deferred): ${p} — ${action.note}`);
        summary.skipped++;
        break;
    }
  }

  if (!dryRun) await writeManifest(docsDir, nextManifest);
  return summary;
}

// -----------------------------------------------------------------
// CLI entry — bin/emdee.js shells `tsx src/cli/sync-command.ts <args>`.
// -----------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const jsonOut = args.includes("--json");
  const docsFlagIdx = args.findIndex((a) => a === "-d" || a === "--docs");
  const docsArg = docsFlagIdx >= 0 ? args[docsFlagIdx + 1] : undefined;
  const docsDir = docsArg
    ? path.resolve(process.cwd(), docsArg)
    : path.resolve(process.env.EMDEE_DOCS ?? path.join(process.cwd(), "docs"));

  try {
    const summary = await runSync({ docsDir, dryRun });
    if (jsonOut) {
      process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
      return;
    }
    const dryTag = summary.dry_run ? " (dry-run — no writes)" : "";
    process.stdout.write(`sync${dryTag}: pushed=${summary.pushed.length} pulled=${summary.pulled.length} conflicts=${summary.conflicts.length} skipped=${summary.skipped}\n`);
    for (const p of summary.pushed) process.stdout.write(`  push  ${p}\n`);
    for (const p of summary.pulled) process.stdout.write(`  pull  ${p}\n`);
    for (const p of summary.conflicts) process.stdout.write(`  CONFLICT  ${p}\n`);
    for (const w of summary.warnings) process.stdout.write(`  warn  ${w}\n`);
  } catch (e) {
    if (e instanceof NeedsLoginError) {
      process.stderr.write(`${e.message}\n`);
      process.exit(2);
    }
    process.stderr.write(`sync failed: ${(e as Error).message}\n`);
    process.exit(1);
  }
}

const isDirect = import.meta.url === `file://${process.argv[1]}`;
if (isDirect) {
  void main();
}
