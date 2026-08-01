// SPRINT-177: aggregate owner-only metrics for whatelz.ai's founder
// cockpit. Every query hits the service-role admin client — this is
// aggregate-across-all-tenants data, never per-user, never PII.
//
// Response shape is a contract with the cockpit consumer. Add fields
// freely; renames/removals require a schema_version bump.

import pkg from "../../../package.json";
import { adminClient } from "../supabase/admin";

const SCHEMA_VERSION = 1;

export interface OwnerMetrics {
  product: "emdee";
  generated_at: string;
  schema_version: number;
  business: BusinessStats;
  usage: UsageStats;
  product_health: ProductHealth;
}

export interface BusinessStats {
  dau: number;
  wau: number;
  mau: number;
  arr_usd: number;
  signups_7d: number;
  churn_30d: number;
  active_workspaces: number;
}

export interface UsageStats {
  docs_total: number;
  docs_added_7d: number;
  sections_added_7d: number;
  sections_updated_7d: number;
  mcp_calls_7d: number | null;
  cli_syncs_7d: number | null;
}

export interface ProductHealth {
  uptime_pct_24h: number | null;
  error_rate_24h: number | null;
  latest_deploy_sha: string | null;
  npm_version: string;
}

// One SQL round-trip per section — three total, run in parallel from
// collectOwnerMetrics(). Each helper wraps its own try/catch that
// returns a null-filled section so a single query failure doesn't hard-
// fail the whole endpoint (the cockpit prefers partial data over 500).

async function getBusinessStats(): Promise<BusinessStats> {
  const admin = adminClient();
  try {
    // One batched query — cheaper than seven .from() calls.
    const { data, error } = await admin.rpc("owner_metrics_business");
    if (error) throw error;
    // Postgres TABLE-returning function → array with one row.
    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> ?? {};
    return {
      dau: numOrZero(row.dau),
      wau: numOrZero(row.wau),
      mau: numOrZero(row.mau),
      arr_usd: 0, // No billing surface yet.
      signups_7d: numOrZero(row.signups_7d),
      churn_30d: 0, // No profiles.deleted_at — nobody can churn today.
      active_workspaces: numOrZero(row.active_workspaces),
    };
  } catch {
    // Fallback: return zeroed section so the endpoint stays 200.
    return {
      dau: 0, wau: 0, mau: 0,
      arr_usd: 0, signups_7d: 0, churn_30d: 0, active_workspaces: 0,
    };
  }
}

async function getUsageStats(): Promise<UsageStats> {
  const admin = adminClient();
  try {
    const { data, error } = await admin.rpc("owner_metrics_usage");
    if (error) throw error;
    // Postgres TABLE-returning function → array with one row.
    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> ?? {};
    return {
      docs_total: numOrZero(row.docs_total),
      docs_added_7d: numOrZero(row.docs_added_7d),
      sections_added_7d: numOrZero(row.sections_added_7d),
      sections_updated_7d: numOrZero(row.sections_updated_7d),
      mcp_calls_7d: numOrZero(row.mcp_calls_7d),
      cli_syncs_7d: null, // sync_manifest tracks files not invocations.
    };
  } catch {
    return {
      docs_total: 0, docs_added_7d: 0,
      sections_added_7d: 0, sections_updated_7d: 0,
      mcp_calls_7d: null, cli_syncs_7d: null,
    };
  }
}

function getProductHealth(): ProductHealth {
  // Synchronous — env + package.json only, no DB call.
  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  return {
    uptime_pct_24h: null,   // No monitoring installed.
    error_rate_24h: null,   // No error-metric collection.
    latest_deploy_sha: typeof sha === "string" && sha.length > 0 ? sha.slice(0, 7) : null,
    npm_version: pkg.version,
  };
}

export async function collectOwnerMetrics(): Promise<OwnerMetrics> {
  const [business, usage] = await Promise.all([
    getBusinessStats(),
    getUsageStats(),
  ]);
  const product_health = getProductHealth();
  return {
    product: "emdee",
    generated_at: new Date().toISOString(),
    schema_version: SCHEMA_VERSION,
    business,
    usage,
    product_health,
  };
}

function numOrZero(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}
