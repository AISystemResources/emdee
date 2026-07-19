// One-time copy of every file in the `vaults` Storage bucket into the
// vault_files Postgres table. Idempotent — re-running upserts so it's
// safe to retry. Run after applying the add_vault_files migration.
//
// Run from project root: node scripts/backfill-vault-files.mjs
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("Missing Supabase env vars");

const sb = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
const bucket = sb.storage.from("vaults");

async function walk(folder) {
  const out = [];
  const { data, error } = await bucket.list(folder || undefined, { limit: 1000 });
  if (error || !data) return out;
  for (const item of data) {
    const p = folder ? `${folder}/${item.name}` : item.name;
    if (item.id === null) {
      out.push(...(await walk(p)));
    } else if (item.name.endsWith(".md")) {
      out.push(p);
    }
  }
  return out;
}

const allPaths = await walk("");
console.log(`Found ${allPaths.length} markdown files.`);

const rows = [];
let i = 0;
for (const fullPath of allPaths) {
  i++;
  const slash = fullPath.indexOf("/");
  const namespace = slash === -1 ? "" : fullPath.slice(0, slash);
  const file_path = slash === -1 ? fullPath : fullPath.slice(slash + 1);
  if (!namespace) continue;
  const { data, error } = await bucket.download(fullPath);
  if (error || !data) {
    console.warn(`  skip ${fullPath}: ${error?.message ?? "no data"}`);
    continue;
  }
  const content = await data.text();
  rows.push({ namespace, file_path, content });
  if (i % 25 === 0) console.log(`  read ${i}/${allPaths.length}`);
}
console.log(`Downloaded ${rows.length} files. Upserting…`);

const BATCH = 200;
for (let j = 0; j < rows.length; j += BATCH) {
  const slice = rows.slice(j, j + BATCH);
  const { error } = await sb.from("vault_files").upsert(slice, { onConflict: "namespace,file_path" });
  if (error) throw error;
  console.log(`  upserted ${Math.min(j + BATCH, rows.length)}/${rows.length}`);
}
console.log("\nDone.");
