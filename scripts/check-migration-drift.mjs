#!/usr/bin/env node
// SPRINT-046 (extended SPRINT-047-followup): detect migrations checked into
// the repo but not yet applied to a Supabase project. Exits non-zero on drift.
//
// Checks **both** EMDEE-prod and EMDEE-test by default. EMDEE-test is checked
// when SUPABASE_TEST_URL + SUPABASE_TEST_SERVICE_ROLE_KEY are present in env;
// missing test creds → prod-only check (preserves the original SPRINT-046
// behaviour for local runs without test creds).
//
// Rationale: SPRINT-047 discovered EMDEE-test was effectively empty — 17
// migrations had been applied to prod but never to test. The original drift
// check only watched prod, so silent test drift went undetected until e2e
// blew up. Checking both projects in the same workflow run catches this.
//
// Source of truth for "applied": the SECURITY DEFINER RPC
// `list_applied_migrations()` reads supabase_migrations.schema_migrations.
//
// Source of truth for "in repo": supabase/migrations/*.sql.
//
// Match rule is loose by design — Supabase's runner sometimes records a
// different name than the file. See `isApplied()` for details.

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

async function listAppliedMigrations(url, key) {
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

function resolveTargets() {
  const targets = [];

  const prodUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const prodKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (prodUrl && prodKey) {
    targets.push({ label: "EMDEE-prod", url: prodUrl, key: prodKey, required: true });
  } else {
    targets.push({
      label: "EMDEE-prod",
      url: null,
      key: null,
      required: true,
      missing: "NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY",
    });
  }

  const testUrl = process.env.SUPABASE_TEST_URL;
  const testKey = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
  if (testUrl && testKey) {
    targets.push({ label: "EMDEE-test", url: testUrl, key: testKey, required: true });
  }
  // EMDEE-test absent silently — local runs without test creds keep the
  // original SPRINT-046 single-target behaviour.

  return targets;
}

async function checkTarget(target, repo, ignored) {
  if (!target.url) {
    return { target, status: "skipped", reason: `env missing (${target.missing})` };
  }
  let applied;
  try {
    applied = await listAppliedMigrations(target.url, target.key);
  } catch (err) {
    return { target, status: "error", reason: err.message };
  }
  const drift = repo.filter((base) => !ignored.has(base) && !isApplied(base, applied));
  return { target, status: drift.length === 0 ? "clean" : "drifted", applied, drift };
}

async function main() {
  const repo = await listRepoMigrations();
  const ignored = await loadIgnoreList();
  const targets = resolveTargets();
  const results = [];
  for (const t of targets) {
    results.push(await checkTarget(t, repo, ignored));
  }

  let exitCode = 0;
  for (const r of results) {
    if (r.status === "clean") {
      console.log(
        `✓ ${r.target.label}: ${repo.length} repo migrations all accounted for (${r.applied.length} applied, ${ignored.size} ignored via .drift-ignore).`,
      );
    } else if (r.status === "skipped") {
      console.log(`◌ ${r.target.label}: skipped — ${r.reason}`);
      // A required target that can't be checked is a hard failure (matches
      // SPRINT-046 behaviour for prod).
      if (r.target.required) exitCode = Math.max(exitCode, 2);
    } else if (r.status === "error") {
      console.error(`✗ ${r.target.label}: check failed — ${r.reason}`);
      exitCode = Math.max(exitCode, 2);
    } else if (r.status === "drifted") {
      console.error(
        `✗ ${r.target.label}: ${r.drift.length} repo migration(s) not found in supabase_migrations.schema_migrations:`,
      );
      for (const base of r.drift) {
        console.error(`    - supabase/migrations/${base}.sql`);
      }
      exitCode = Math.max(exitCode, 1);
    }
  }

  if (exitCode === 1) {
    console.error(
      "\nFix options:",
      "\n  1. Apply via mcp__supabase__apply_migration to the drifted project(s), OR run `supabase db push` linked to each project.",
      "\n  2. If the file is a duplicate of an already-applied migration with a different name, add the basename to supabase/migrations/.drift-ignore.",
      "\n  3. Delete the file if the feature is dropped.",
      "\n\nReminder: apply new migrations to BOTH EMDEE-prod AND EMDEE-test, in the same change.",
    );
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
