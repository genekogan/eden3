import type { Metadata } from "next";
import { SettingsShell } from "@/components/agents/settings/settings-shell";
import { VoiceSettings } from "@/components/agents/settings/voice-settings";

export const metadata: Metadata = { title: "Voice · Settings" };

export default async function AgentVoiceSettingsPage({
  params,
}: {
  params: Promise<{ username: string }>;
}) {
  const { username } = await params;
  const decoded = decodeURIComponent(username);
  return (
    <SettingsShell
      username={decoded}
      title="Voice"
      hint="Choose how this agent sounds, preview it, and manage consent-bound custom voices."
    >
      <VoiceSettings username={decoded} />
    </SettingsShell>
  );
}
