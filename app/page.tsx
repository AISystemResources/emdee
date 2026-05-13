import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { AppShell } from "./components/AppShell";

export const dynamic = "force-dynamic";

// Public workspace for unauthenticated visitors. Signed-in users go straight to their workspace.
export default async function PublicWorkspace() {
  const { userId } = await auth();
  if (userId) redirect(`/${userId}`);
  redirect("/sign-in");
}
