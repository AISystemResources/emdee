// SPRINT-057 (SIG-008): trashed-state sidecar.
//
// Trash is a per-doc lifecycle state, NOT a reparent into `graveyard/`.
// Persisted out-of-band so the doc's markdown stays untouched and its
// graph edges remain intact for lossless restore.
//
// Storage location:
//   - Local mode: `<docsDir>/.emdee/trashed.json`
//   - Cloud mode: `<userId>/.emdee/trashed.json` in the `vaults` Supabase
//     bucket. Doesn't appear in /api/index (the list filter only picks
//     up `.md` files) so the sidecar is invisible to the renderer.
//
// Shape: `{ [docPath]: { original_parent_path, trashed_at } }`. Keyed
// by the doc's vault path (without namespace prefix); the value records
// where to restore the doc to + when it was trashed.

import { promises as fs } from "node:fs";
import path from "node:path";
import { adminClient } from "@/src/lib/supabase/admin";
import type { ToolContext } from "../mcp/tools/types";

const VAULT_BUCKET = "vaults";
const SIDECAR_PATH = ".emdee/trashed.json";

export interface TrashedEntry {
  original_parent_path: string;
  trashed_at: string;
}

export type TrashedState = Record<string, TrashedEntry>;

function localSidecarPath(docsDir: string): string {
  return path.join(docsDir, SIDECAR_PATH);
}

function cloudSidecarKey(userId: string): string {
  return `${userId}/${SIDECAR_PATH}`;
}

export async function readTrashedState(ctx: ToolContext): Promise<TrashedState> {
  if (ctx.mode === "local") {
    try {
      const raw = await fs.readFile(localSidecarPath(ctx.docsDir), "utf8");
      return JSON.parse(raw) as TrashedState;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
  }
  const { data, error } = await adminClient()
    .storage.from(VAULT_BUCKET)
    .download(cloudSidecarKey(ctx.userId));
  if (error) {
    // Not-found errors mean no trash file yet — treat as empty.
    const msg = error.message?.toLowerCase() ?? "";
    if (msg.includes("not found") || msg.includes("does not exist")) return {};
    throw new Error(`trash state download failed: ${error.message}`);
  }
  const text = await data.text();
  return JSON.parse(text) as TrashedState;
}

export async function writeTrashedState(
  ctx: ToolContext,
  state: TrashedState,
): Promise<void> {
  const body = JSON.stringify(state, null, 2);
  if (ctx.mode === "local") {
    const filePath = localSidecarPath(ctx.docsDir);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, body, "utf8");
    return;
  }
  const { error } = await adminClient()
    .storage.from(VAULT_BUCKET)
    .upload(cloudSidecarKey(ctx.userId), body, {
      contentType: "application/json",
      upsert: true,
    });
  if (error) throw new Error(`trash state upload failed: ${error.message}`);
}

/** Convenience: the set of trashed paths in this vault. Used by /api/index
 *  to filter out trashed docs from the renderer view. */
export async function listTrashedPaths(ctx: ToolContext): Promise<Set<string>> {
  const state = await readTrashedState(ctx);
  return new Set(Object.keys(state));
}
