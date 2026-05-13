import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

// All routes are publicly accessible — auth is enforced per-operation in route handlers.
// clerkMiddleware() still populates auth() / useUser() for routes that need it.
// Bypass Clerk for API routes to test if Clerk dev-mode handshake is causing issue.
export default clerkMiddleware((auth, req) => {
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.next();
  }
});

export const config = {
  matcher: ["/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)", "/(api|trpc)(.*)"],
};
