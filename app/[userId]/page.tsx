import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { AppShell } from "@/app/components/AppShell";

interface Props {
  params: Promise<{ userId: string }>;
}

export default async function UserWorkspace({ params }: Props) {
  const { userId: currentUserId } = await auth();
  if (!currentUserId) redirect("/sign-in");
  const { userId } = await params;
  return <AppShell namespace={userId} />;
}
