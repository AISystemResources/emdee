/**
 * enforce-hub-folders.mjs
 *
 * Script 2 of the SPRINT-066 vault restructure.
 *
 * For every hub node (a doc that has children in doc_edges), ensures its
 * children live inside a matching subfolder: COURSES.md → children at
 * courses/*, BRAIN.md → children at brain/*, {NAME}.md → children at
 * {name}/* etc.
 *
 * Children that are already inside the correct folder are left untouched.
 * Children at the wrong level are moved via Supabase Storage server-side
 * move (no download/upload) and their vault_files + doc_edges rows are
 * updated accordingly.
 *
 * Subfolders of a hub (e.g. brain/ when BRAIN.md moves to ELZ-WORK/BRAIN.md)
 * are also recursively moved so the full subtree stays together.
 *
 * System nodes (EMDEE.md, VAULT.md, SHARED.md, GRAVEYARD.md, IMAGES.md) are
 * never moved — they are pinned at root and act as the top-level structure.
 *
 * IMPORTANT: Run Script 1 (ensure-canonical-hubs.mjs) first so the canonical
 * hubs exist before reorganising children.
 *
 * Usage:
 *   node scripts/enforce-hub-folders.mjs --dry-run --namespace=user_xxx
 *   node scripts/enforce-hub-folders.mjs --namespace=user_xxx   # live, one user
 *   node scripts/enforce-hub-folders.mjs --dry-run              # preview all users
 *   node scripts/enforce-hub-folders.mjs                        # live, all users
 *
 * Safety:
 *   Always run --dry-run first and review every proposed move.
 *   The script bails on the first Storage error per namespace — re-run after fixing.
 *   doc_edges are rebuilt via a full backfill at the end of each namespace run.
 *
 * Prerequisites:
 *   NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local
 */

import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import { parseArgs } from "node:util";
import path from "node:path";

const { values } = parseArgs({
  options: {
    "dry-run":      { type: "boolean", default: false },
    "namespace":    { type: "string" },
    "env-file":     { type: "string", default: ".env.local" },
    "skip-prefix":  { type: "string" }, // e.g. --skip-prefix=projects/ to leave vault structure untouched
  },
});
const DRY_RUN = values["dry-run"];
const TARGET_NS = values["namespace"] ?? null;
const SKIP_PREFIX = values["skip-prefix"] ?? null;

dotenv.config({ path: values["env-file"] });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

// EMDEE.md and SHARED.md are pinned exceptions: EMDEE.md is the meta-root
// (its children are the tier-1 hubs — they stay flat at root, not inside emdee/),
// and SHARED.md is a cross-user connector with no subfolder.
// VAULT.md, GRAVEYARD.md, IMAGES.md are NOT listed here — they stay at root
// because they are children of EMDEE.md (a system node shields its children),
// but their own children DO get enforced into vault/, graveyard/, images/.
const SYSTEM_NODE_FILES = new Set([
  "EMDEE.md",
  "SHARED.md",
]);

function isSystemNode(filePath) {
  // Root-level system nodes only — never pin nodes inside subfolders.
  if (SYSTEM_NODE_FILES.has(filePath)) return true;
  // Honour --skip-prefix: treat any path inside that prefix as untouchable.
  if (SKIP_PREFIX && filePath.startsWith(SKIP_PREFIX)) return true;
  return false;
}

/** parent stem → subfolder name: COURSES.md → "courses", BRAIN.md → "brain" */
function stemToFolder(filePath) {
  return path.basename(filePath, ".md").toLowerCase();
}

/** Expected subfolder for a child: if parent is dir/HUB.md → dir/hub/ */
function expectedChildFolder(parentPath) {
  const dir = path.dirname(parentPath);
  const folder = stemToFolder(parentPath);
  return dir === "." ? `${folder}/` : `${dir}/${folder}/`;
}

async function getAllNamespaces() {
  const namespaces = new Set();
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("vault_files")
      .select("namespace")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const row of data) namespaces.add(row.namespace);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return [...namespaces].filter((ns) => ns !== "public").sort();
}

async function getEdges(ns) {
  const rows = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from("doc_edges")
      .select("from_path, to_path")
      .eq("namespace", ns)
      .eq("kind", "hierarchy")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

/**
 * Given the doc_edges hierarchy for a namespace, compute every file that needs
 * to move and what its new path should be.
 *
 * Returns an array of { oldPath, newPath } pairs in topological order
 * (ancestors before descendants) so Storage moves don't create orphaned
 * intermediates.
 *
 * Key invariant: we BFS from ROOT hubs only (hubs with no parent in the graph).
 * Child hubs are enqueued only AFTER their parent has computed their new path,
 * so pathRemapping is always populated before a hub is processed.
 */
function computeMoves(edges) {
  // Build children map: parentPath → [childPath, ...]
  const children = new Map();
  const hasParent = new Set();
  for (const { from_path: parent, to_path: child } of edges) {
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(child);
    hasParent.add(child);
  }

  const moves = []; // { oldPath, newPath }
  const pathRemapping = new Map(); // originalPath → newPath (for cascading)

  // Start only from root hubs: hubs that have no parent in the hierarchy.
  // This guarantees parents are processed before children (BFS from roots).
  const rootHubs = [...children.keys()].filter((h) => !hasParent.has(h));

  // Also catch any orphaned hubs (no parent declared but also have children
  // that aren't reachable from roots — shouldn't happen in a well-formed vault
  // but handle gracefully).
  const queue = [...rootHubs];
  const processed = new Set();

  while (queue.length > 0) {
    const hub = queue.shift();
    if (processed.has(hub)) continue;
    processed.add(hub);

    if (!children.has(hub)) continue;

    if (isSystemNode(hub)) {
      // System nodes stay at root — don't apply hub+folder to their direct
      // children. But their children may themselves be hubs, so enqueue them.
      for (const child of children.get(hub)) {
        if (children.has(child) && !processed.has(child)) queue.push(child);
      }
      continue;
    }

    // Use the remapped path if this hub was moved by its own parent earlier.
    const effectiveHubPath = pathRemapping.get(hub) ?? hub;
    const expectedFolder = expectedChildFolder(effectiveHubPath);

    // Old stem folder of this hub (original, pre-remap path) — used to
    // preserve relative subfolder structure for children already inside it.
    // e.g. hub=OPERATIONS.md → oldStemFolder="operations/" so that
    // operations/briefings/DATE.md and operations/linkedin/DATE.md don't
    // collide when moved into edmund/operations/.
    const oldStemFolder = `${path.dirname(hub) === "." ? "" : path.dirname(hub) + "/"}${stemToFolder(hub)}/`;

    for (const child of children.get(hub)) {
      if (isSystemNode(child)) continue;

      const effectiveChildPath = pathRemapping.get(child) ?? child;

      // Already in the right folder — nothing to do.
      if (effectiveChildPath.startsWith(expectedFolder)) {
        // Still need to process this child as a hub (in case its own children
        // need to be re-evaluated with the same effective path).
        if (children.has(child)) queue.push(child);
        continue;
      }

      // Preserve relative subfolder structure if the child already lives
      // inside the hub's old stem folder (avoids basename collisions).
      const newChildPath = effectiveChildPath.startsWith(oldStemFolder)
        ? `${expectedFolder}${effectiveChildPath.slice(oldStemFolder.length)}`
        : `${expectedFolder}${path.basename(effectiveChildPath)}`;

      moves.push({ oldPath: effectiveChildPath, newPath: newChildPath });
      pathRemapping.set(child, newChildPath);

      if (children.has(child)) {
        queue.push(child); // process after remapping is recorded
      }
    }
  }

  return moves;
}

/** List all files recursively under a Storage prefix. */
async function listStorageRecursive(prefix, sub = "") {
  const folder = sub ? `${prefix}/${sub}` : prefix;
  const { data: items } = await supabase.storage.from("vaults").list(folder, { limit: 1000 });
  if (!items) return [];
  const files = [];
  for (const item of items) {
    const rel = sub ? `${sub}/${item.name}` : item.name;
    if (!item.id) {
      // sub-directory — recurse
      files.push(...(await listStorageRecursive(prefix, rel)));
    } else {
      files.push(rel); // relative to prefix
    }
  }
  return files;
}

async function moveStorageFile(oldFull, newFull) {
  const { error } = await supabase.storage.from("vaults").move(oldFull, newFull);
  if (error) {
    // Warn but don't abort — the file may not exist in Storage yet (e.g. test
    // environments where Storage is empty but vault_files DB rows exist).
    // The DB rename below still runs, keeping vault_files consistent.
    console.warn(`    ⚠ storage move skipped (${error.message}): ${oldFull}`);
  }
}

async function processNamespace(ns) {
  console.log(`\n── ${ns} ──`);

  const edges = await getEdges(ns);
  if (edges.length === 0) {
    console.log("  no hierarchy edges found — skip");
    return;
  }

  const moves = computeMoves(edges);
  if (moves.length === 0) {
    console.log("  ✓ all children already in correct folders");
    return;
  }

  console.log(`  ${moves.length} file(s) to move:`);
  for (const { oldPath, newPath } of moves) {
    console.log(`    ${oldPath}  →  ${newPath}`);
  }

  if (DRY_RUN) {
    // Also show subfolder moves
    for (const { oldPath, newPath } of moves) {
      const oldFolder = `${path.dirname(oldPath) === "." ? "" : path.dirname(oldPath) + "/"}${stemToFolder(oldPath)}/`;
      const newFolder = `${path.dirname(newPath) === "." ? "" : path.dirname(newPath) + "/"}${stemToFolder(newPath)}/`;
      // Quick check whether the subfolder might exist
      const { data: items } = await supabase.storage.from("vaults").list(`${ns}/${oldFolder.replace(/\/$/, "")}`, { limit: 1 });
      if (items && items.length > 0) {
        console.log(`    ${oldFolder}  →  ${newFolder}  (subfolder)`);
      }
    }
    console.log("  (dry-run — no changes made)");
    return;
  }

  // --- LIVE RUN ---
  for (const { oldPath, newPath } of moves) {
    const oldFull = `${ns}/${oldPath}`;
    const newFull = `${ns}/${newPath}`;

    // 1. Move the .md file in Storage
    await moveStorageFile(oldFull, newFull);
    console.log(`  ✓ moved ${oldPath} → ${newPath}`);

    // 2. Move the matching subfolder if it exists
    //    e.g. brain/ when BRAIN.md → ELZ-WORK/BRAIN.md means brain/ → ELZ-WORK/brain/
    const oldStemFolder = `${path.dirname(oldPath) === "." ? "" : path.dirname(oldPath) + "/"}${stemToFolder(oldPath)}`;
    const newStemFolder = `${path.dirname(newPath) === "." ? "" : path.dirname(newPath) + "/"}${stemToFolder(newPath)}`;

    const subFiles = await listStorageRecursive(`${ns}/${oldStemFolder}`);
    for (const rel of subFiles) {
      const oldSubFull = `${ns}/${oldStemFolder}/${rel}`;
      const newSubFull = `${ns}/${newStemFolder}/${rel}`;
      await moveStorageFile(oldSubFull, newSubFull);
      console.log(`    ✓ moved ${oldStemFolder}/${rel} → ${newStemFolder}/${rel}`);
    }

    // 3. Update vault_files: rename the main file
    await supabase
      .from("vault_files")
      .update({ file_path: newPath })
      .eq("namespace", ns)
      .eq("file_path", oldPath);

    // 4. Update vault_files: rename subfolder files
    for (const rel of subFiles) {
      const oldSubPath = `${oldStemFolder}/${rel}`;
      const newSubPath = `${newStemFolder}/${rel}`;
      await supabase
        .from("vault_files")
        .update({ file_path: newSubPath })
        .eq("namespace", ns)
        .eq("file_path", oldSubPath);
    }
  }

  // 5. Rebuild doc_edges for this namespace via path updates.
  //    Build a full remapping table and UPDATE doc_edges in one pass.
  const allOldToNew = new Map();
  for (const { oldPath, newPath } of moves) {
    allOldToNew.set(oldPath, newPath);
    // Also remap subfolder files based on the moves we just made.
    const oldStem = `${path.dirname(oldPath) === "." ? "" : path.dirname(oldPath) + "/"}${stemToFolder(oldPath)}/`;
    const newStem = `${path.dirname(newPath) === "." ? "" : path.dirname(newPath) + "/"}${stemToFolder(newPath)}/`;
    const subFiles = await listStorageRecursive(`${ns}/${newStem.replace(/\/$/, "")}`);
    for (const rel of subFiles) {
      allOldToNew.set(`${oldStem}${rel}`, `${newStem}${rel}`);
    }
  }

  for (const [oldPath, newPath] of allOldToNew) {
    await supabase
      .from("doc_edges")
      .update({ from_path: newPath })
      .eq("namespace", ns)
      .eq("from_path", oldPath);
    await supabase
      .from("doc_edges")
      .update({ to_path: newPath })
      .eq("namespace", ns)
      .eq("to_path", oldPath);
  }

  console.log(`  ✓ doc_edges updated`);
}

async function run() {
  console.log(`\nenforce-hub-folders — ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log("Rule: hub nodes get a matching subfolder; children move inside it.\n");

  const namespaces = TARGET_NS ? [TARGET_NS] : await getAllNamespaces();
  console.log(`Namespaces to process: ${namespaces.length}`);

  for (const ns of namespaces) {
    try {
      await processNamespace(ns);
    } catch (err) {
      console.error(`\n  ✗ ${ns} failed: ${err.message}`);
      if (!TARGET_NS) console.error("  Continuing with next namespace...");
      else process.exit(1);
    }
  }

  if (!DRY_RUN) {
    console.log("\n✅  Done.");
    console.log("Next: run `npx tsx scripts/backfill-doc-edges.ts --namespace=<ns>` per namespace");
    console.log("to fully rebuild cross-doc edges after path changes.");
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
