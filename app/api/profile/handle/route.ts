import { auth } from "@clerk/nextjs/server";
import { adminClient } from "@/src/lib/supabase/admin";
import { validateHandle } from "@/src/lib/owner/handle";

export const runtime = "nodejs";

export async function PATCH(request: Request) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const raw = typeof (body as Record<string, unknown>)?.handle === "string"
    ? ((body as Record<string, unknown>).handle as string)
    : "";

  const check = validateHandle(raw);
  if (!check.ok) return Response.json({ error: check.error }, { status: 400 });

  const { error } = await adminClient()
    .from("profiles")
    .update({ handle: check.handle })
    .eq("clerk_id", userId);

  if (error) {
    // Postgres unique_violation on the handle column.
    if (error.code === "23505") {
      return Response.json({ error: "handle_taken" }, { status: 409 });
    }
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ ok: true, handle: check.handle });
}
