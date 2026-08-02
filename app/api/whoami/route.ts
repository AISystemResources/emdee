// SPRINT-091: identity probe for the CLI's `emdee whoami` command.
//
// Trades a Bearer token for `{ namespace, email }`. Zero side effects. Used
// by the CLI to confirm login succeeded, and by any future tool that wants
// to display "logged in as <you>". Same auth path as /api/mcp — reuses
// `clerkIdFromOAuthToken`.

import { clerkClient } from "@clerk/nextjs/server";
import { clerkIdFromOAuthToken } from "@/src/lib/supabase/oauth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization",
};

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(request: Request): Promise<Response> {
  const principal = await clerkIdFromOAuthToken(request);
  if (!principal) {
    return Response.json(
      { error: "unauthorized", error_description: "invalid or expired token" },
      { status: 401, headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } },
    );
  }
  const clerkId = principal.clerkId;

  let email: string | null = null;
  try {
    const client = await clerkClient();
    const user = await client.users.getUser(clerkId);
    const primary = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId);
    email = primary?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? null;
  } catch {
    // Non-fatal — namespace is the load-bearing field.
  }

  return Response.json(
    { namespace: clerkId, email },
    { headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } },
  );
}
