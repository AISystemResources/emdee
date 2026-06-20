#!/usr/bin/env node
// SPRINT-046: detect migrations checked into the repo but not yet applied to
// the cloud Supabase database. Exits non-zero on drift so CI fails. Ported
// from DOUBLELEAD's sprint-011 follow-up (see RALPHLOOP-READINESS §F).
//
// Source of truth for "applied":
//   select version, name from supabase_migrations.schema_migrations
//   (exposed via SECURITY DEFINER RPC list_applied_migrations())
//
// Source of truth for "in repo":
//   supabase/migrations/*.sql (basename without .sql extension)
//
// Match rule: a repo file `<name>.sql` is considered applied if any applied
// row's `version || '_' || name` OR `name` (case-insensitive) lines up with
// the repo basename's semantic-name component. Loose by design — Supabase's
// migration runner sometimes records a different name than the file (e.g.
// file `20260420_smm_drive_columns.sql` becomes version `20260420215255`
// name `smm_drive_columns`). What we care about is catching brand-new files
// that have zero match.
//
// Required env: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY pointing
// at the prod project. The drift workflow in CI passes these from secrets.

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "supabase", "migrations");
const IGNORE_FILE = join(MIGRATIONS_DIR, ".drift-ignore");

async function listRepoMigrations() {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.replace(/\.sql$/, ""))
    .sort();
}

async function loadIgnoreList() {
  try {
    const raw = await readFile(IGNORE_FILE, "utf8");
    return new Set(
      raw
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#")),
    );
  } catch (err) {
    if (err.code === "ENOENT") return new Set();
    throw err;
  }
}

async function listAppliedMigrations() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    throw new Error(
      "Need NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in env to query applied migrations.",
    );
  }

  const res = await fetch(`${url}/rest/v1/rpc/list_applied_migrations`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });

  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(
        "RPC list_applied_migrations() not found. Apply migration `<ts>_list_applied_migrations_rpc.sql` to the database, then re-run.",
      );
    }
    throw new Error(`PostgREST RPC failed: ${res.status} ${await res.text()}`);
  }

  const rows = await res.json();
  return rows.map((r) => ({ version: r.version, name: r.name }));
}

function semanticName(s) {
  return s
    .toLowerCase()
    .replace(/^\d{8}[a-z]?_/, "")
    .replace(/^\d{14}_/, "");
}

function isApplied(repoBase, applied) {
  const repoSem = semanticName(repoBase);
  const repoLower = repoBase.toLowerCase();
  for (const row of applied) {
    const composite = `${row.version}_${row.name}`.toLowerCase();
    if (composite === repoLower) return true;
    const appliedSem = semanticName(row.name ?? "");
    if (appliedSem && appliedSem === repoSem) return true;
    if (appliedSem && repoSem.includes(appliedSem)) return true;
    if (appliedSem && appliedSem.includes(repoSem)) return true;
  }
  return false;
}

async function main() {
  const repo = await listRepoMigrations();
  const ignored = await loadIgnoreList();
  let applied;
  try {
    applied = await listAppliedMigrations();
  } catch (err) {
    console.error(`✗ migration-drift check skipped: ${err.message}`);
    process.exit(2);
  }

  const drift = repo.filter((base) => !ignored.has(base) && !isApplied(base, applied));

  if (drift.length === 0) {
    console.log(
      `✓ migration-drift: ${repo.length} repo migrations all accounted for (${applied.length} applied, ${ignored.size} ignored via .drift-ignore).`,
    );
    process.exit(0);
  }

  console.error(
    `✗ migration-drift: ${drift.length} repo migration(s) not found in supabase_migrations.schema_migrations:`,
  );
  for (const base of drift) {
    console.error(`    - supabase/migrations/${base}.sql`);
  }
  console.error(
    "\nFix options:",
    "\n  1. Apply via mcp__supabase__apply_migration or supabase CLI.",
    "\n  2. If the file is a duplicate of an already-applied migration with a different name, add the basename to supabase/migrations/.drift-ignore.",
    "\n  3. Delete the file if the feature is dropped.",
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
