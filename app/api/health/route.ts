// SPRINT-053 (SIG-002): liveness endpoint.
//
// External monitoring tools (UptimeRobot, Vercel monitoring, etc.) poll this
// to detect downtime. Intentionally bare-bones — no auth, no DB, no env reads
// — so the endpoint itself can't become a source of false negatives.
//
// `deployed_at` is captured at module load (cold start). It moves on each new
// deployment, so consumers can also use it to detect "did we ship?" without
// hitting `/api/index` or the homepage.

const DEPLOYED_AT = new Date().toISOString();

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    status: "ok",
    deployed_at: DEPLOYED_AT,
  });
}
