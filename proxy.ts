// SPRINT-148: legacy URL redirect + Clerk middleware chain.
// Clerk 7 requires clerkMiddleware() to be invoked from the proxy file
// (Next 16's renamed middleware entry point) so auth() calls work in
// server components. Our extra logic wraps around it.
//
// Extra logic:
// - `/user_XXXXX` → `/vault/user_XXXXX` (308) — backward compat for the
//   pre-SPRINT-148 URL scheme so bookmarks keep working.

import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

const LEGACY_USER_ID_PATTERN = /^\/(user_[A-Za-z0-9]+)\/?$/;

export default clerkMiddleware(async (_auth, req) => {
  const match = LEGACY_USER_ID_PATTERN.exec(req.nextUrl.pathname);
  if (match) {
    const url = req.nextUrl.clone();
    url.pathname = `/vault/${match[1]}`;
    return NextResponse.redirect(url, 308);
  }
  return NextResponse.next();
});

export const config = {
  matcher: [
    // Skip Next internals + static assets.
    "/((?!_next/static|_next/image|favicon\\.ico).*)",
    // Also include API routes so Clerk auth() works on route handlers.
    "/(api|trpc)(.*)",
  ],
};
