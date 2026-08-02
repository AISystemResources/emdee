import { exchangeCode } from "@/src/lib/supabase/oauth";

export const dynamic = "force-dynamic";

const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

export async function POST(request: Request) {
  let params: URLSearchParams | null = null;
  let body: Record<string, string> = {};

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await request.text();
    params = new URLSearchParams(text);
    for (const [k, v] of params) body[k] = v;
  } else {
    try {
      body = await request.json();
    } catch {
      return tokenError("invalid_request", "body must be form-encoded or JSON", 400);
    }
  }

  const { grant_type, code, redirect_uri, client_id, code_verifier } = body;

  if (grant_type !== "authorization_code") return tokenError("unsupported_grant_type", "only authorization_code is supported", 400);
  if (!code || !redirect_uri || !client_id || !code_verifier) return tokenError("invalid_request", "missing required parameters", 400);

  try {
    const result = await exchangeCode({ code, clientId: client_id, redirectUri: redirect_uri, codeVerifier: code_verifier });
    if (!result) return tokenError("invalid_grant", "code is invalid, expired, or already used", 400);

    return Response.json({
      access_token: result.token,
      token_type: "Bearer",
      expires_in: TOKEN_TTL_SECONDS,
      // SPRINT-178: echo the actual granted scope per RFC 6749 §5.1
      // instead of hardcoding "mcp". Clients can inspect this to know
      // what they were granted (may be narrower than what was requested).
      scope: result.scope,
    });
  } catch (err) {
    return tokenError("server_error", (err as Error).message, 500);
  }
}

function tokenError(error: string, description: string, status: number) {
  return Response.json({ error, error_description: description }, {
    status,
    headers: { "Cache-Control": "no-store", "Pragma": "no-cache" },
  });
}
