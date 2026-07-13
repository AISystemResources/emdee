/**
 * setup-automation-hub.mjs — SPRINT-081
 *
 * Idempotent bootstrap: create the AUTOMATION.md hub under a user's owner
 * node. Repeatable across accounts — pass --namespace + --user-folder and
 * the script figures the rest from convention (owner node at root =
 * `<USER-FOLDER-UPPER>.md`).
 *
 * Usage:
 *   node scripts/setup-automation-hub.mjs --namespace user_XXXX --user-folder edmund
 *   node scripts/setup-automation-hub.mjs --namespace user_XXXX --user-folder edmund --dry-run
 */

import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, "..");

dotenv.config({ path: ".env.local" });

const { values } = parseArgs({
  options: {
    namespace: { type: "string" },
    "user-folder": { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});

if (!values.namespace || !values["user-folder"]) {
  console.error("usage: node scripts/setup-automation-hub.mjs --namespace <ns> --user-folder <slug> [--dry-run]");
  process.exit(1);
}

const NS = values.namespace;
const USER_FOLDER = values["user-folder"];
const OWNER_TITLE = USER_FOLDER.toUpperCase();
const OWNER_FILE_PATH = `${OWNER_TITLE}.md`;
const AUTOMATION_REL = `${USER_FOLDER}/AUTOMATION.md`;
const SUMMARISER_REL = `${USER_FOLDER}/automation/SUMMARISER.md`;
const BUCKET = "vaults";
const DRY_RUN = values["dry-run"];

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const AUTOMATION_CONTENT = `# AUTOMATION

> Vault-level workflows the ecosystem runs on the user's behalf — skills, routines, and their outputs. Distinct from [[PROJECTS]] (built things) and [[OPERATIONS]] (day-to-day cockpit) — AUTOMATION is where the vault does work FOR the user, unattended.

## Child of

* [[${OWNER_TITLE}]]

## Parent of

`;

async function readCache(filePath) {
  const { data, error } = await sb
    .from("vault_files")
    .select("content")
    .match({ namespace: NS, file_path: filePath })
    .maybeSingle();
  if (error) throw new Error(`vault_files read failed for ${filePath}: ${error.message}`);
  return data ? String(data.content ?? "") : null;
}

async function writeStorage(filePath, content) {
  const storagePath = `${NS}/${filePath}`;
  const blob = new Blob([content], { type: "text/markdown; charset=utf-8" });
  const { error } = await sb.storage.from(BUCKET).upload(storagePath, blob, {
    upsert: true,
    contentType: "text/markdown; charset=utf-8",
  });
  if (error) throw new Error(`storage upload failed for ${storagePath}: ${error.message}`);

  const { error: cacheErr } = await sb
    .from("vault_files")
    .upsert(
      { namespace: NS, file_path: filePath, content, updated_at: new Date().toISOString() },
      { onConflict: "namespace,file_path" },
    );
  if (cacheErr) console.warn(`  ⚠ vault_files upsert failed for ${filePath}: ${cacheErr.message}`);
}

/**
 * Add `* [[AUTOMATION]]` under the `## Parent of` heading in the owner
 * doc. Preserves prior bullets. No-op if already listed.
 */
function patchParentOf(ownerContent) {
  const AUTO_BULLET = "* [[AUTOMATION]]";
  const lines = ownerContent.split(/\r?\n/);
  const parentIdx = lines.findIndex((l) => /^##\s+Parent of\s*$/.test(l));

  if (parentIdx === -1) {
    // Append a new Parent of section at the end.
    return { changed: true, content: ownerContent.replace(/\s*$/, "") + `\n\n## Parent of\n\n${AUTO_BULLET}\n` };
  }

  // Slice from parentIdx to next H2 (or EOF).
  let endIdx = lines.length;
  for (let i = parentIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { endIdx = i; break; }
  }
  const section = lines.slice(parentIdx + 1, endIdx);
  if (section.some((l) => l.trim() === AUTO_BULLET)) {
    return { changed: false, content: ownerContent };
  }

  // Insert the bullet at the end of the section body, preserving trailing blank line.
  const bulletLines = section.filter((l) => l.trim().startsWith("* "));
  const insertAt = bulletLines.length > 0
    ? parentIdx + 1 + section.lastIndexOf(bulletLines[bulletLines.length - 1]) + 1
    : parentIdx + 2;
  const before = lines.slice(0, insertAt);
  const after = lines.slice(insertAt);
  return { changed: true, content: [...before, AUTO_BULLET, ...after].join("\n") };
}

async function run() {
  console.log(`${DRY_RUN ? "DRY RUN" : "LIVE RUN"}: namespace=${NS} user-folder=${USER_FOLDER}`);
  console.log(`  owner hub: ${OWNER_FILE_PATH}`);
  console.log(`  automation hub: ${AUTOMATION_REL}\n`);

  // 1. AUTOMATION.md — create if missing.
  const existing = await readCache(AUTOMATION_REL);
  if (existing) {
    console.log(`  ${AUTOMATION_REL} already exists — leaving it alone.`);
  } else {
    console.log(`  creating ${AUTOMATION_REL}`);
    if (!DRY_RUN) await writeStorage(AUTOMATION_REL, AUTOMATION_CONTENT);
  }

  // 1b. SUMMARISER.md — seed from repo template if missing.
  const existingSummariser = await readCache(SUMMARISER_REL);
  if (existingSummariser) {
    console.log(`  ${SUMMARISER_REL} already exists — leaving it alone.`);
  } else {
    const templatePath = path.join(pkgRoot, "templates", "automation", "SUMMARISER.md");
    const summariserContent = await readFile(templatePath, "utf8");
    console.log(`  creating ${SUMMARISER_REL}`);
    if (!DRY_RUN) await writeStorage(SUMMARISER_REL, summariserContent);
  }

  // 2. Patch owner hub Parent of.
  const owner = await readCache(OWNER_FILE_PATH);
  if (!owner) {
    console.error(`  ✗ owner hub not found at ${OWNER_FILE_PATH}. Aborting.`);
    process.exit(1);
  }
  const patched = patchParentOf(owner);
  if (patched.changed) {
    console.log(`  patching ${OWNER_FILE_PATH} Parent of → adds [[AUTOMATION]]`);
    if (!DRY_RUN) await writeStorage(OWNER_FILE_PATH, patched.content);
  } else {
    console.log(`  ${OWNER_FILE_PATH} Parent of already lists [[AUTOMATION]] — no change.`);
  }

  console.log("\n✅ done.");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
