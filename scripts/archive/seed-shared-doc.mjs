// Seed a real SHARED.md into every vault namespace (public + every user)
// and add [[SHARED]] to VAULT.md's "## Parent of" list so the new node
// renders as a child of VAULT in the tree.
//
// Idempotent — if SHARED.md already exists it's left alone; if VAULT.md
// already lists [[SHARED]] the file isn't touched.
//
// Run from project root: node scripts/seed-shared-doc.mjs
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

const SHARED_CONTENT = `# SHARED

> Docs that other users have shared into your vault. Visible to your MCP tools and renderer; the content lives in the owner's vault and is read-only here.

## Child of

* [[VAULT]]
`;

async function listNamespaces() {
  const { data, error } = await bucket.list("", { limit: 1000 });
  if (error) throw error;
  return (data ?? [])
    .filter((d) => d.id === null) // folders only
    .map((d) => d.name);
}

async function exists(ns, file) {
  const { data } = await bucket.list(ns, { search: file, limit: 1 });
  return (data ?? []).some((f) => f.name === file && f.id !== null);
}

async function read(p) {
  const { data, error } = await bucket.download(p);
  if (error || !data) return null;
  return await data.text();
}

async function write(p, content) {
  const blob = new Blob([content], { type: "text/markdown; charset=utf-8" });
  const { error } = await bucket.upload(p, blob, {
    upsert: true,
    contentType: "text/markdown; charset=utf-8",
  });
  if (error) throw error;
}

/**
 * Ensure VAULT.md's "## Parent of" block lists [[SHARED]]. Returns true if
 * the file was modified.
 */
function addSharedToVault(vaultMd) {
  if (/^\s*\*\s*\[\[SHARED\]\]\s*$/m.test(vaultMd)) return null;
  const lines = vaultMd.split("\n");
  let inParentOf = false;
  let lastBulletIdx = -1;
  let parentOfHeadingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+Parent of\s*$/.test(line)) {
      inParentOf = true;
      parentOfHeadingIdx = i;
      continue;
    }
    if (inParentOf) {
      if (/^##\s/.test(line)) break;
      if (/^\s*\*\s/.test(line)) lastBulletIdx = i;
    }
  }
  if (parentOfHeadingIdx === -1) {
    // No Parent of section yet — append one.
    lines.push("", "## Parent of", "", "* [[SHARED]]", "");
    return lines.join("\n");
  }
  const insertAt = lastBulletIdx === -1 ? parentOfHeadingIdx + 1 : lastBulletIdx + 1;
  lines.splice(insertAt, 0, "* [[SHARED]]");
  return lines.join("\n");
}

async function seedNamespace(ns) {
  const sharedPath = `${ns}/SHARED.md`;
  const vaultPath = `${ns}/VAULT.md`;

  let sharedCreated = false;
  if (!(await exists(ns, "SHARED.md"))) {
    await write(sharedPath, SHARED_CONTENT);
    sharedCreated = true;
  }

  let vaultUpdated = false;
  if (await exists(ns, "VAULT.md")) {
    const vault = await read(vaultPath);
    if (vault) {
      const next = addSharedToVault(vault);
      if (next) {
        await write(vaultPath, next);
        vaultUpdated = true;
      }
    }
  }

  return { sharedCreated, vaultUpdated };
}

const namespaces = await listNamespaces();
console.log(`Found ${namespaces.length} namespaces.\n`);
for (const ns of namespaces) {
  const r = await seedNamespace(ns);
  const tag = r.sharedCreated || r.vaultUpdated ? "✓" : "·";
  console.log(`${tag} ${ns}  SHARED.md ${r.sharedCreated ? "created" : "exists"}, VAULT.md ${r.vaultUpdated ? "updated" : "unchanged"}`);
}
console.log("\nDone.");
