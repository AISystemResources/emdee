/**
 * One-time migration: copy all files from Vercel Blob → Supabase Storage (vaults bucket).
 *
 * Run with:
 *   BLOB_READ_WRITE_TOKEN=... NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     npx tsx scripts/migrate-blob-to-supabase.ts
 *
 * Safe to re-run: uploads are upserts, existing files are overwritten.
 */

import { list as blobList } from "@vercel/blob";
import { createClient } from "@supabase/supabase-js";

const BUCKET = "vaults";

const token = process.env.BLOB_READ_WRITE_TOKEN;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!token || !supabaseUrl || !serviceRoleKey) {
  console.error("Missing required env vars: BLOB_READ_WRITE_TOKEN, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function ensureBucket() {
  const { error } = await supabase.storage.createBucket(BUCKET, { public: false });
  if (error && !error.message.includes("already exists")) {
    throw new Error(`Failed to create bucket: ${error.message}`);
  }
}

async function migrate() {
  await ensureBucket();
  console.log(`Bucket '${BUCKET}' ready.`);

  const { blobs } = await blobList({ token });
  const mdBlobs = blobs.filter((b) => b.pathname.endsWith(".md"));
  console.log(`Found ${mdBlobs.length} markdown files in Vercel Blob.`);

  let ok = 0;
  let fail = 0;

  for (const blob of mdBlobs) {
    try {
      const res = await fetch(blob.url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const content = await res.text();

      const file = new Blob([content], { type: "text/markdown; charset=utf-8" });
      const { error } = await supabase.storage.from(BUCKET).upload(blob.pathname, file, {
        upsert: true,
        contentType: "text/markdown; charset=utf-8",
      });
      if (error) throw new Error(error.message);

      console.log(`  ✓ ${blob.pathname}`);
      ok++;
    } catch (err) {
      console.error(`  ✗ ${blob.pathname}: ${(err as Error).message}`);
      fail++;
    }
  }

  console.log(`\nDone: ${ok} migrated, ${fail} failed.`);
  if (fail > 0) process.exit(1);
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
