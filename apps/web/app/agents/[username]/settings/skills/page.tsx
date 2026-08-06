import type { Metadata } from "next";
import { SettingsShell } from "@/components/agents/settings/settings-shell";
import { SkillsSettings } from "./skills-client";

export const metadata: Metadata = { title: "Skills · Settings" };

export default async function AgentSkillsSettingsPage({
  params,
}: {
  params: Promise<{ username: string }>;
}) {
  const { username } = await params;
  const decoded = decodeURIComponent(username);
  return (
    <SettingsShell
      username={decoded}
      title="Skills"
      hint="Curated and approved skills this agent can call on, drawn from the skill catalog."
    >
      <SkillsSettings username={decoded} />
    </SettingsShell>
  );
}
