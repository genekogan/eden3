import type { Metadata } from "next";
import { SettingsShell } from "@/components/agents/settings/settings-shell";
import { IdentityForm } from "@/components/agents/settings/identity-form";

export const metadata: Metadata = { title: "Identity · Settings" };

export default async function AgentIdentitySettingsPage({
  params,
}: {
  params: Promise<{ username: string }>;
}) {
  const { username } = await params;
  const decoded = decodeURIComponent(username);
  return (
    <SettingsShell
      username={decoded}
      title="Identity"
      hint="The agent's public face — avatar, name, description, and greeting. Changes are hot: they shape the very next message."
    >
      <IdentityForm username={decoded} />
    </SettingsShell>
  );
}
