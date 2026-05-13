export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return Response.json({
    ok: true,
    ts: Date.now(),
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "MISSING",
    hasSecretKey: !!process.env.SUPABASE_SECRET_KEY,
    hasServiceKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    docsDir: process.env.EMDEE_DOCS ?? "MISSING",
  });
}
