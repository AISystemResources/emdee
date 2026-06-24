/**
 * clean-info-sample.mjs
 *
 * Hard-deletes INFO.md, SAMPLE.md, and all sample/ children from the Supabase
 * Storage vaults bucket across every namespace.
 *
 * Run once after the vault_files / doc_edges SQL cleanup.
 *
 * Usage:
 *   node scripts/clean-info-sample.mjs --dry-run
 *   node scripts/clean-info-sample.mjs
 */

import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import { parseArgs } from "node:util";

dotenv.config({ path: ".env.local" });

const { values } = parseArgs({ options: { "dry-run": { type: "boolean", default: false } } });
const DRY_RUN = values["dry-run"];

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const TARGETS = ["INFO.md", "info/SAMPLE.md"];

async function collectPaths(namespace) {
  const paths = [];
  // Direct files
  for (const target of TARGETS) {
    paths.push(`${namespace}/${target}`);
  }
  // Recurse into info/sample/
  await collectFolder(`${namespace}/info/sample`, paths);
  return paths;
}

async function collectFolder(prefix, paths) {
  const { data } = await supabase.storage.from("vaults").list(prefix, { limit: 1000 });
  if (!data) return;
  for (const item of data) {
    const fullPath = `${prefix}/${item.name}`;
    if (!item.id) {
      await collectFolder(fullPath, paths);
    } else {
      paths.push(fullPath);
    }
  }
}

async function run() {
  console.log(`\n${DRY_RUN ? "DRY RUN\n" : "LIVE RUN\n"}`);

  // List all top-level namespaces in the vaults bucket
  const { data: namespaces, error } = await supabase.storage.from("vaults").list("", { limit: 1000 });
  if (error) { console.error(error); process.exit(1); }

  for (const ns of namespaces ?? []) {
    const paths = await collectPaths(ns.name);
    const existing = [];
    for (const p of paths) {
      const { data } = await supabase.storage.from("vaults").list(p.split("/").slice(0, -1).join("/"), { limit: 1 });
      const name = p.split("/").at(-1);
      if (data?.some((f) => f.name === name)) existing.push(p);
    }
    if (existing.length === 0) continue;
    console.log(`\n${ns.name}: deleting ${existing.length} file(s)`);
    for (const p of existing) console.log(`  ${p}`);
    if (!DRY_RUN) {
      const { error: delErr } = await supabase.storage.from("vaults").remove(existing);
      if (delErr) console.warn(`  ⚠ ${delErr.message}`);
      else console.log(`  ✓`);
    }
  }

  console.log("\n✅  Done.");
}

run().catch((e) => { console.error(e); process.exit(1); });
