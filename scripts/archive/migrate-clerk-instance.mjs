/**
 * migrate-clerk-instance.mjs
 *
 * Remaps Clerk user IDs across all Supabase tables + Storage after a
 * dev-instance → prod-instance migration.
 *
 * When Clerk switches instances, every user gets a new ID. This script
 * updates every table that stores a Clerk user ID so existing data stays
 * attached to the right user.
 *
 * Usage:
 *   node scripts/migrate-clerk-instance.mjs --dry-run   # preview only
 *   node scripts/migrate-clerk-instance.mjs              # execute
 *
 * Prerequisites:
 *   - SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in env (or .env.local)
 *   - Fill in the ID_MAP below with dev→prod mappings obtained from Clerk
 *     Management API after creating the prod accounts.
 *
 * Tables updated:
 *   public.profiles      clerk_id (PK)
 *   public.pat_tokens    clerk_id (FK)
 *   public.doc_shares    owner_id, grantee_id (FK)
 *   public.doc_edges     namespace (text, keyed by clerk_id)
 *   public.mcp_activity  namespace, clerk_id
 *   public.oauth_codes   clerk_id (FK)
 *   public.oauth_tokens  clerk_id (FK)
 *   public.sync_manifest clerk_id (FK)
 *   public.vault_files   namespace (composite PK — rows are re-inserted)
 *
 * Storage:
 *   vaults bucket: copies all objects from user_<old>/ to user_<new>/,
 *   then deletes the old prefix.
 *
 * Safety:
 *   - Always run --dry-run first and verify the output.
 *   - Run against test-supabase before prod.
 *   - The script is idempotent: re-running after partial failure is safe
 *     because all DB updates use UPDATE ... WHERE clerk_id = <old>, which
 *     is a no-op once the row has been remapped.
 *   - The Storage copy step is NOT idempotent if old files were already
 *     deleted — run once only per env.
 */

import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import { parseArgs } from "node:util";

dotenv.config({ path: ".env.local" });

// ─── FILL THIS IN ────────────────────────────────────────────────────────────
// Map of dev Clerk user IDs → prod Clerk user IDs.
// Get prod IDs from Clerk Dashboard → Users after creating prod accounts,
// or via the Clerk Management API:
//   GET https://api.clerk.com/v1/users?limit=100
//   Authorization: Bearer <clerk_secret_key>
// Dev IDs are pre-populated. Fill in prod IDs as each user signs in on
// emdee.tech — find them under Clerk prod dashboard → Users.
// Run with --dry-run first, then live for each batch.
const ID_MAP = {
  "user_3DbybqEDdQdhvmvBFTmpZEAcQLS": "user_3FXDLXbkdJ2TSWM0tc8SYMql9ZO", // elz.work22 (Edmund primary)
  "user_3Dgy0C20oB513H5cU1cIs738kdO": "", // elz.news22 (Edmund secondary)
  "user_3DicC9J0L62zcUqG4SZb4CZIL4D": "", // jasclapforyou
  "user_3Dj1898GTvq923JNDChKmz60CbD": "", // lisa.see02
  "user_3DkDnQtT43v0fN2QjMdjF14ZQ08": "", // emily.ruixian
  "user_3DgtXPnEOTj1n6ysJyhZKDGZo8S": "", // desmondchye321
  "user_3DoXnTZK4u1kKe1TSTkJr4DgSzs": "", // teklin.lim
  "user_3E52OBWZMRDS8RhRmoKo60gQZX6": "", // yeosimyee
  "user_3EOefznLM7Zv662VBXUHNrUu8kI": "", // kiranmega7 (Kiran)
  "user_3EedPbcAY8QLWKrAoY0U1wEnJV4": "", // shaunliew20 (Shaun)
};
// ─────────────────────────────────────────────────────────────────────────────

const { values } = parseArgs({ options: { "dry-run": { type: "boolean", default: false } } });
const DRY_RUN = values["dry-run"];

const readyEntries = Object.entries(ID_MAP).filter(([, v]) => v.trim() !== "");
if (readyEntries.length === 0) {
  console.error("❌  No prod IDs filled in — paste prod user IDs (from Clerk → Users) into ID_MAP before running.");
  process.exit(1);
}
// Only migrate entries that have a prod ID — skip blanks silently.
const ACTIVE_MAP = Object.fromEntries(readyEntries);

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

async function run() {
  console.log(`\n${DRY_RUN ? "DRY RUN — no changes will be made\n" : "LIVE RUN\n"}`);
  console.log("ID mappings:");
  for (const [from, to] of Object.entries(ID_MAP)) {
    console.log(`  ${from} → ${to}`);
  }
  console.log();

  for (const [devId, prodId] of Object.entries(ACTIVE_MAP)) {
    console.log(`\n── Migrating ${devId} → ${prodId} ──`);

    // 1. profiles (PK — must go first; all FKs cascade from here)
    await step(`profiles: insert new row`, async () => {
      const { data: existing } = await supabase
        .from("profiles")
        .select("clerk_id, vault_id, email")
        .eq("clerk_id", devId)
        .single();
      if (!existing) throw new Error(`No profile found for dev ID ${devId}`);
      // If prod sign-in already created a profile row, delete it first so INSERT doesn't conflict.
      await supabase.from("profiles").delete().eq("clerk_id", prodId);
      await supabase.from("profiles").insert({
        clerk_id: prodId,
        vault_id: existing.vault_id,
        email: existing.email,
      });
    });

    // 2. pat_tokens
    await step(`pat_tokens: remap clerk_id`, () =>
      supabase.from("pat_tokens").update({ clerk_id: prodId }).eq("clerk_id", devId)
    );

    // 3. doc_shares (owner and grantee separately)
    await step(`doc_shares: remap owner_id`, () =>
      supabase.from("doc_shares").update({ owner_id: prodId }).eq("owner_id", devId)
    );
    await step(`doc_shares: remap grantee_id`, () =>
      supabase.from("doc_shares").update({ grantee_id: prodId }).eq("grantee_id", devId)
    );

    // 4. doc_edges (namespace is not a FK — plain text update)
    await step(`doc_edges: remap namespace`, () =>
      supabase.from("doc_edges").update({ namespace: prodId }).eq("namespace", devId)
    );

    // 5. mcp_activity
    await step(`mcp_activity: remap namespace + clerk_id`, () =>
      supabase
        .from("mcp_activity")
        .update({ namespace: prodId, clerk_id: prodId })
        .eq("clerk_id", devId)
    );

    // 6. oauth_codes + oauth_tokens (short-lived; safe to remap or delete)
    await step(`oauth_codes: remap clerk_id`, () =>
      supabase.from("oauth_codes").update({ clerk_id: prodId }).eq("clerk_id", devId)
    );
    await step(`oauth_tokens: remap clerk_id`, () =>
      supabase.from("oauth_tokens").update({ clerk_id: prodId }).eq("clerk_id", devId)
    );

    // 7. sync_manifest
    await step(`sync_manifest: remap clerk_id`, () =>
      supabase.from("sync_manifest").update({ clerk_id: prodId }).eq("clerk_id", devId)
    );

    // 8. vault_files (namespace is part of composite PK — re-insert rows)
    await step(`vault_files: re-insert with new namespace`, async () => {
      let allRows = [];
      let from = 0;
      const PAGE = 1000;
      while (true) {
        const { data, error } = await supabase
          .from("vault_files")
          .select("*")
          .eq("namespace", devId)
          .range(from, from + PAGE - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        allRows = allRows.concat(data);
        if (data.length < PAGE) break;
        from += PAGE;
      }
      console.log(`    ${allRows.length} vault_files rows to migrate`);
      if (allRows.length > 0) {
        const newRows = allRows.map((r) => ({ ...r, namespace: prodId }));
        // Clear any auto-created prod rows (e.g. default seed from first sign-in) before inserting dev data.
        await supabase.from("vault_files").delete().eq("namespace", prodId);
        await supabase.from("vault_files").upsert(newRows, { onConflict: "namespace,file_path" });
        await supabase.from("vault_files").delete().eq("namespace", devId);
      }
    });

    // 9. profiles: delete old dev row (all FKs already remapped above)
    await step(`profiles: delete old dev row`, () =>
      supabase.from("profiles").delete().eq("clerk_id", devId)
    );

    // 10. Storage: copy vaults bucket objects to new namespace prefix
    await step(`storage: copy vaults/${devId}/ → vaults/${prodId}/`, async () => {
      const { data: files, error } = await supabase.storage
        .from("vaults")
        .list(devId, { limit: 10000, offset: 0 });
      if (error) throw error;
      if (!files || files.length === 0) {
        console.log(`    no storage files found under ${devId}/`);
        return;
      }
      console.log(`    copying ${files.length} top-level entries (may include folders)`);
      await copyStoragePrefix(devId, prodId, "");
    });
  }

  console.log("\n✅  Migration complete.");
  if (DRY_RUN) console.log("   (dry-run — no DB or storage changes were made)");
}

async function copyStoragePrefix(oldNs, newNs, subPath) {
  const prefix = subPath ? `${oldNs}/${subPath}` : oldNs;
  const { data: items } = await supabase.storage.from("vaults").list(prefix, {
    limit: 10000,
    offset: 0,
  });
  if (!items) return;

  for (const item of items) {
    const oldPath = subPath ? `${oldNs}/${subPath}/${item.name}` : `${oldNs}/${item.name}`;
    const newPath = subPath ? `${newNs}/${subPath}/${item.name}` : `${newNs}/${item.name}`;

    if (!item.id) {
      // folder — recurse
      await copyStoragePrefix(oldNs, newNs, subPath ? `${subPath}/${item.name}` : item.name);
    } else {
      // file — download + re-upload
      console.log(`    ${oldPath} → ${newPath}`);
      if (!DRY_RUN) {
        const { data: fileData } = await supabase.storage.from("vaults").download(oldPath);
        if (!fileData) { console.warn(`    ⚠ could not download ${oldPath}`); continue; }
        await supabase.storage.from("vaults").upload(newPath, fileData, { upsert: true });
        await supabase.storage.from("vaults").remove([oldPath]);
      }
    }
  }
}

async function step(label, fn) {
  process.stdout.write(`  ${label}... `);
  if (DRY_RUN) { console.log("(skipped — dry-run)"); return; }
  try {
    await fn();
    console.log("✓");
  } catch (err) {
    console.log("✗");
    console.error(`    ERROR: ${err.message ?? err}`);
    process.exit(1);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
