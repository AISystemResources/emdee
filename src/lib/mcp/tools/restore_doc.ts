import { validatePath } from "./vault";
import { readTrashedState, writeTrashedState } from "../../trash/state";
import type { ToolContext } from "./types";

// SPRINT-057 (SIG-008): restore a previously-trashed doc by clearing its
// entry in `.emdee/trashed.json`. The doc's markdown is untouched
// throughout the trash → restore cycle; only the lifecycle flag moves.

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export async function restoreDoc(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<unknown> {
  const docPath = String(args.path ?? "");
  if (!docPath) return json({ error: "path required" });
  validatePath(docPath);

  const state = await readTrashedState(ctx);
  const entry = state[docPath];
  if (!entry) {
    return json({ error: "not_trashed", path: docPath });
  }

  delete state[docPath];
  await writeTrashedState(ctx, state);

  return json({
    ok: true,
    path: docPath,
    restored_to: entry.original_parent_path,
    was_trashed_at: entry.trashed_at,
  });
}
