import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { AppShell } from "./components/AppShell";

export const dynamic = "force-dynamic";

// SPRINT-052 (SIG-009): public landing metadata. SSR'd into the HTML head
// so link previews + SEO work without waiting for the client-rendered shell.
export const metadata: Metadata = {
  title: "EMDEE — your knowledge graph in markdown",
  description:
    "Local-first knowledge graph + MCP server. Plain markdown files, rendered as a navigable graph and read by Claude as context.",
  openGraph: {
    title: "EMDEE",
    description: "Your knowledge graph, in markdown, for you and Claude.",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "EMDEE",
    description: "Your knowledge graph, in markdown, for you and Claude.",
  },
};

// Public workspace for unauthenticated visitors. Signed-in users go straight to their workspace.
export default async function PublicWorkspace() {
  const { userId } = await auth();
  if (userId) redirect(`/${userId}`);
  // showCta only when unauthenticated (which is the only path that reaches here).
  return <AppShell namespace="public" showCta />;
}
