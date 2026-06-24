import { auth } from "@clerk/nextjs/server";
import { adminClient } from "@/src/lib/supabase/admin";
import { normalizeOwnerTitle } from "@/src/lib/owner/identity";

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

  const raw = typeof (body as Record<string, unknown>)?.nickname === "string"
    ? ((body as Record<string, unknown>).nickname as string).trim()
    : "";

  if (!raw) return Response.json({ error: "nickname_required" }, { status: 400 });
  if (raw.length > 64) return Response.json({ error: "nickname_too_long" }, { status: 400 });

  const title = normalizeOwnerTitle(raw);
  if (title === "OWNER") {
    return Response.json({ error: "nickname_reserved" }, { status: 400 });
  }

  const { error } = await adminClient()
    .from("profiles")
    .update({ nickname: raw })
    .eq("clerk_id", userId);

  if (error) return Response.json({ error: error.message }, { status: 500 });

  return Response.json({ ok: true, title });
}
