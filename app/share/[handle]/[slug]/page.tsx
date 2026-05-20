import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { PublicShareView } from "@/app/components/PublicShareView";
import type { DocIndex } from "@/src/core/indexer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Params {
  params: Promise<{ handle: string; slug: string }>;
}

interface PublicResponse {
  publication: {
    id: string;
    handle: string;
    slug: string;
    root_doc_path: string;
    owner_email: string | null;
  };
  index: DocIndex;
}

/**
 * Server component for /share/<handle>/<slug>. Resolves the publication
 * server-side so the initial HTML carries the doc index — no client-side
 * loading spinner. Falls through to 404 when the handle or slug doesn't
 * resolve.
 */
export default async function SharePage({ params }: Params) {
  const { handle, slug } = await params;

  // Build an absolute URL to the public API. Reads the request host so the
  // call works in dev (localhost), preview, and prod without env vars.
  const h = await headers();
  const host = h.get("host") ?? "";
  const proto = h.get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
  const base = `${proto}://${host}`;
  const apiUrl = `${base}/api/public/${encodeURIComponent(handle)}/${encodeURIComponent(slug)}`;

  const res = await fetch(apiUrl, { cache: "no-store" });
  if (!res.ok) notFound();
  const payload = (await res.json()) as PublicResponse;
  if (!payload?.publication) notFound();

  const { userId } = await auth();
  const isSignedIn = !!userId;

  return (
    <PublicShareView
      publication={payload.publication}
      index={payload.index}
      isSignedIn={isSignedIn}
    />
  );
}
