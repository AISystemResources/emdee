// SPRINT-185: `emdee seed-agents` — one-shot idempotent seeding of the
// AGENTS hub, four role templates, and the agent-loop skill into the
// caller's namespace.
//
// Source: `<pkgRoot>/seed-vault/vault/**/*.md`. Target: user's namespace
// with the `seed-vault/` prefix stripped.
//
// Idempotency rule: check target path existence — if present, skip
// (user edits win). Never overwrite.
//
// Cloud-only. New users signing up already get seeds via the existing
// public/ Storage copy on first `/api/index` visit; this verb catches
// existing users who predate the AGENTS content.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { callTool, unwrapText } from "./remote-client";
import { NeedsLoginError } from "./auth";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface SeedFile {
  targetPath: string;
  content: string;
}

const SEED_ROOT = join(__dirname, "..", "..", "seed-vault");

function walkMarkdown(root: string): Array<{ absPath: string; relPath: string }> {
  const out: Array<{ absPath: string; relPath: string }> = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile() && e.name.endsWith(".md")) {
        try {
          const st = statSync(full);
          if (!st.isFile()) continue;
        } catch { continue; }
        out.push({ absPath: full, relPath: relative(root, full) });
      }
    }
  }
  return out;
}

function loadSeeds(): SeedFile[] {
  const files = walkMarkdown(SEED_ROOT);
  return files.map((f) => ({
    targetPath: f.relPath,
    content: readFileSync(f.absPath, "utf8"),
  }));
}

interface DocEnvelope {
  path: string;
  error?: string;
  doc_content_hash?: string;
}

async function docExists(targetPath: string): Promise<boolean> {
  try {
    const raw = await callTool("get_doc", { path: targetPath });
    const text = unwrapText(raw as { content?: Array<{ type: string; text?: string }> });
    const parsed = JSON.parse(text) as DocEnvelope;
    return !parsed.error;
  } catch (e) {
    // Cloud tool throws "no such doc: ..." for missing paths. Treat that
    // (and any other read error) as "doesn't exist" so the caller writes it.
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("no such doc")) return false;
    if (e instanceof NeedsLoginError) throw e;
    return false;
  }
}

async function writeSeed(seed: SeedFile): Promise<{ path: string; wrote: boolean; error?: string }> {
  try {
    if (await docExists(seed.targetPath)) {
      return { path: seed.targetPath, wrote: false };
    }
    const raw = await callTool("write_doc", {
      path: seed.targetPath,
      content: seed.content,
    });
    const text = unwrapText(raw as { content?: Array<{ type: string; text?: string }> });
    const parsed = JSON.parse(text) as { ok?: boolean; error?: string };
    if (parsed.error) return { path: seed.targetPath, wrote: false, error: parsed.error };
    return { path: seed.targetPath, wrote: true };
  } catch (e) {
    if (e instanceof NeedsLoginError) throw e;
    return { path: seed.targetPath, wrote: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function main() {
  const seeds = loadSeeds();
  if (seeds.length === 0) {
    console.error("emdee seed-agents: no seed files found under seed-vault/. Is your emdee install intact?");
    process.exit(1);
  }

  const results: Array<{ path: string; wrote: boolean; error?: string }> = [];
  for (const seed of seeds) {
    const result = await writeSeed(seed);
    results.push(result);
  }

  const wrote = results.filter((r) => r.wrote).length;
  const skipped = results.filter((r) => !r.wrote && !r.error).length;
  const failed = results.filter((r) => r.error);

  // JSON output when stdout isn't a TTY (script consumption).
  if (!process.stdout.isTTY) {
    console.log(JSON.stringify({
      ok: failed.length === 0,
      total: results.length,
      wrote,
      skipped,
      failed: failed.length,
      results,
    }, null, 2));
    return;
  }

  console.log(`emdee seed-agents:`);
  console.log(`  ${wrote} seeded, ${skipped} skipped (already present), ${failed.length} failed`);
  if (failed.length > 0) {
    console.log("");
    console.log("Failures:");
    for (const f of failed) console.log(`  ${f.path}: ${f.error}`);
  }
  if (wrote > 0) {
    console.log("");
    console.log("Run `emdee reconcile --remote --all` to rebuild the edge cache for the new docs.");
  }
}

main().catch((e) => {
  if (e instanceof NeedsLoginError) {
    console.error("emdee seed-agents: not logged in. Run `emdee login` first.");
    process.exit(2);
  }
  console.error("emdee seed-agents failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
