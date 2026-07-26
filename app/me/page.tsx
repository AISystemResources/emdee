import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// After sign-in, Clerk redirects here. We resolve the userId and forward to the workspace.
export default async function MePage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");
  redirect(`/vault/${userId}`);
}
