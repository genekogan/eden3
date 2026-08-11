import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { agentSectionHref, isEveUsername } from "@/lib/eve";
import { SettingsUnsavedChangesProvider } from "@/components/agents/settings/unsaved-changes";

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
  return <SettingsUnsavedChangesProvider>{children}</SettingsUnsavedChangesProvider>;
}
