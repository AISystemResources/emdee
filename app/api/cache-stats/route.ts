import { auth } from "@clerk/nextjs/server";
import { adminClient } from "@/src/lib/supabase/admin";
import { getStorageCacheStats } from "@/src/lib/storage/SupabaseStorage";
import { getIndexMemoStats } from "@/src/lib/mcp/tools/vault";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * SPRINT-035 observability: returns the in-memory hit/miss counters for
 * the storage list cache (`SupabaseStorage`) and the `loadVaultIndex`
 * memo (`vault.ts`). Counters are per-function-instance and reset on
 * cold start — `curl /api/cache-stats` from time to time to spot-check
 * the hit ratio.
 *
 * Gated on `profiles.is_admin` (same flag the publications admin uses).
 *
 * Once we're confident the cache is doing its job (storage.search
 * volume on the Supabase dashboard drops ≥80% from baseline), this
 * endpoint becomes optional. Leaving it in for future regressions.
 */
export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const { data: profile } = await adminClient()
    .from("profiles")
    .select("is_admin")
    .eq("clerk_id", userId)
    .maybeSingle();
  if (!profile?.is_admin) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  return Response.json(
    {
      storageList: getStorageCacheStats(),
      indexMemo: getIndexMemoStats(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
