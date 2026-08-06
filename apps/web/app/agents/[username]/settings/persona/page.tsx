import type { Metadata } from "next";
import { SettingsShell } from "@/components/agents/settings/settings-shell";
import { PersonaEditor } from "@/components/agents/settings/persona-editor";

export const metadata: Metadata = { title: "Persona · Settings" };

export default async function AgentPersonaSettingsPage({
  params,
}: {
  params: Promise<{ username: string }>;
}) {
  const { username } = await params;
  const decoded = decodeURIComponent(username);
  return (
    <SettingsShell
      username={decoded}
      title="Persona"
      hint="The agent's soul — this edits its SOUL.md file directly. Edits here, in Workspace, or by the agent itself all touch the same file."
    >
      <PersonaEditor username={decoded} />
    </SettingsShell>
  );
}
