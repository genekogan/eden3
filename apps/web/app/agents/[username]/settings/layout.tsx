import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { agentSectionHref, isEveUsername } from "@/lib/eve";

export default async function AgentSettingsLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ username: string }>;
}) {
  const { username: encodedUsername } = await params;
  const username = decodeURIComponent(encodedUsername);
  if (isEveUsername(username)) redirect(agentSectionHref(username, "chats"));
  return children;
}
