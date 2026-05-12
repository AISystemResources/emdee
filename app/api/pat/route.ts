import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

async function hashToken(token: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token)
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function resolveUser(req: Request) {
  const authHeader = req.headers.get("authorization") ?? "";
  const sessionToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!sessionToken) return null;
  const { data } = await adminClient().auth.getUser(sessionToken);
  return data.user ?? null;
}

// GET /api/pat — returns whether a token exists (no plaintext)
// POST /api/pat — rotates/creates token, returns plaintext once
export async function GET(req: Request) {
  const user = await resolveUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const db = adminClient().schema("emdee");
  const { data } = await db
    .from("pat_tokens")
    .select("created_at")
    .eq("user_id", user.id)
    .maybeSingle();

  return NextResponse.json({ exists: !!data, created_at: data?.created_at ?? null });
}

export async function POST(req: Request) {
  const user = await resolveUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const token = generateToken();
  const hash = await hashToken(token);

  const db = adminClient().schema("emdee");
  const { error } = await db.from("pat_tokens").upsert(
    { user_id: user.id, token_hash: hash, created_at: new Date().toISOString() },
    { onConflict: "user_id" }
  );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ token });
}
