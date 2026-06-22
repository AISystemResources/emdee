import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { LandingPage } from "./components/LandingPage";

export const dynamic = "force-dynamic";

export default async function Root() {
  const { userId } = await auth();
  if (userId) redirect(`/${userId}`);
  return <LandingPage />;
}
