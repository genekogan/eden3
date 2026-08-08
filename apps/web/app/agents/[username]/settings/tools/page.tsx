import type { Metadata } from "next";
import { SettingsShell } from "@/components/agents/settings/settings-shell";
import { ToolsForm } from "@/components/agents/settings/tools-form";

export const metadata: Metadata = { title: "Tools · Settings" };

export default async function AgentToolsSettingsPage({
  params,
}: {
  params: Promise<{ username: string }>;
}) {
  const { username } = await params;
  const decoded = decodeURIComponent(username);
  return (
    <SettingsShell
      username={decoded}
      title="Tools"
      hint="What this agent is allowed to use. The Advanced panel holds the raw runtime knobs."
    >
      <ToolsForm username={decoded} />
    </SettingsShell>
  );
}
