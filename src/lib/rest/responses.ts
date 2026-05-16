// Tiny response helpers so every route emits the same envelope shape.
// REST clients (Coze, GPT Actions, manual curl) parse JSON; we return
// `{ ok: true, ... }` on success and `{ ok: false, error, message? }`
// on every failure path. Status codes follow the obvious mapping.

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Max-Age": "86400",
};

export function withCors(res: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

export function ok(body: Record<string, unknown> = {}, status = 200): Response {
  return withCors(
    Response.json({ ok: true, ...body }, { status, headers: { "cache-control": "no-store" } })
  );
}

export function fail(error: string, status: number, extra: Record<string, unknown> = {}): Response {
  return withCors(
    Response.json({ ok: false, error, ...extra }, { status, headers: { "cache-control": "no-store" } })
  );
}

export const unauthorized = () =>
  fail("unauthorized", 401, { message: "Missing or invalid Authorization: Bearer <token> header." });

export const forbidden = (extra?: Record<string, unknown>) =>
  fail("forbidden", 403, { message: "Token is valid but doesn't have access to this resource.", ...extra });

export const notFound = (what: string) =>
  fail("not_found", 404, { message: `${what} not found.` });

export const badRequest = (message: string, extra: Record<string, unknown> = {}) =>
  fail("bad_request", 400, { message, ...extra });

export const serverError = (message: string) =>
  fail("server_error", 500, { message });

export const corsPreflight = () => withCors(new Response(null, { status: 204 }));
