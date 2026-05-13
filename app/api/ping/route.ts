export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ status: "pong", marker: "ping-route-fresh-2026-05-14" });
}
