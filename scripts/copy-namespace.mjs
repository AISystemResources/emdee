/**
 * copy-namespace.mjs
 *
 * Copies all Storage files from one namespace prefix to another and
 * populates vault_files for the destination namespace.
 *
 * Does NOT delete the source — run again with --delete-src to clean up
 * after you've verified everything looks right.
 *
 * Usage:
 *   node scripts/copy-namespace.mjs --src=<old_clerk_id> --dst=<new_clerk_id>
 *   node scripts/copy-namespace.mjs --src=... --dst=... --delete-src
 */

import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import { parseArgs } from "node:util";

dotenv.config({ path: ".env.local" });

const { values } = parseArgs({
  options: {
    src: { type: "string" },
    dst: { type: "string" },
    "delete-src": { type: "boolean", default: false },
  },
});

if (!values.src || !values.dst) {
  console.error("Usage: node scripts/copy-namespace.mjs --src=<old_id> --dst=<new_id>");
  process.exit(1);
}

const SRC = values.src;
const DST = values.dst;
const DELETE_SRC = values["delete-src"];

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

async function listAll(prefix) {
  const out = [];
  const { data, error } = await sb.storage.from("vaults").list(prefix, { limit: 1000 });
  if (error || !data) return out;
  for (const item of data) {
    const fullPath = `${prefix}/${item.name}`;
    if (item.id === null) {
      out.push(...(await listAll(fullPath)));
    } else {
      out.push(fullPath);
    }
  }
  return out;
}

console.log(`\nScanning Storage: ${SRC}/...`);
const srcFiles = await listAll(SRC);
console.log(`Found ${srcFiles.length} files.\n`);

if (srcFiles.length === 0) {
  console.error(`No files found under ${SRC}/`);
  process.exit(1);
}

let copied = 0;
const vaultRows = [];

for (const srcPath of srcFiles) {
  const dstPath = DST + srcPath.slice(SRC.length);
  const filePath = srcPath.slice(SRC.length + 1); // relative path (no namespace prefix)

  const { data: blob, error: dlErr } = await sb.storage.from("vaults").download(srcPath);
  if (dlErr || !blob) {
    console.warn(`  SKIP (download failed) ${srcPath}: ${dlErr?.message ?? "no data"}`);
    continue;
  }

  const { error: ulErr } = await sb.storage.from("vaults").upload(dstPath, blob, { upsert: true });
  if (ulErr) {
    console.warn(`  SKIP (upload failed) ${dstPath}: ${ulErr.message}`);
    continue;
  }

  if (srcPath.endsWith(".md")) {
    const content = await blob.text();
    vaultRows.push({ namespace: DST, file_path: filePath, content });
  }

  copied++;
  if (copied % 25 === 0) console.log(`  copied ${copied}/${srcFiles.length}`);
}

console.log(`\nCopied ${copied}/${srcFiles.length} Storage files to ${DST}/`);

if (vaultRows.length > 0) {
  console.log(`\nPopulating vault_files: ${vaultRows.length} .md files...`);
  const BATCH = 100;
  for (let i = 0; i < vaultRows.length; i += BATCH) {
    const slice = vaultRows.slice(i, i + BATCH);
    const { error } = await sb.from("vault_files").upsert(slice, { onConflict: "namespace,file_path" });
    if (error) throw error;
    console.log(`  upserted ${Math.min(i + BATCH, vaultRows.length)}/${vaultRows.length}`);
  }
}

if (DELETE_SRC) {
  console.log(`\nDeleting source files from ${SRC}/...`);
  for (const srcPath of srcFiles) {
    await sb.storage.from("vaults").remove([srcPath]);
  }
  console.log(`Deleted ${srcFiles.length} source files.`);
}

console.log(`\n✅  Done.`);
console.log(`Next: npx tsx scripts/backfill-doc-edges.ts --namespace=${DST}`);
