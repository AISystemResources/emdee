import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { AppShell } from "../components/AppShell";

export const dynamic = "force-dynamic";

// Public vault renderer. Signed-in users are forwarded to their personal
// workspace at /vault/{userId}. Unauthenticated visitors see the public
// EMDEE vault with a sign-in CTA. Moved from `/` to `/vault` in SPRINT-148
// so `/` can host the marketing homepage.
export const metadata: Metadata = {
  title: "EMDEE Public Vault",
  description:
    "Browse the public EMDEE knowledge graph — the same view logged-in users get for their own vault.",
  openGraph: {
    title: "EMDEE Public Vault",
    description: "Browse the public EMDEE knowledge graph.",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "EMDEE Public Vault",
    description: "Browse the public EMDEE knowledge graph.",
  },
};

export default async function PublicWorkspace() {
  const { userId } = await auth();
  if (userId) redirect(`/vault/${userId}`);
  return <AppShell namespace="public" showCta />;
}
