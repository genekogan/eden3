import type { Metadata } from "next";
import { SettingsShell } from "@/components/agents/settings/settings-shell";
import { MemorySettings } from "./memory-client";

export const metadata: Metadata = { title: "Memory · Settings" };

export default async function AgentMemorySettingsPage({
  params,
}: {
  params: Promise<{ username: string }>;
}) {
  const { username } = await params;
  const decoded = decodeURIComponent(username);
  return (
    <SettingsShell
      username={decoded}
      title="Memory"
      hint="The agent's collective memory (MEMORY.md), per-person notes, and dream diary — owned and evolved by the agent's own dreaming."
    >
      <MemorySettings username={decoded} />
    </SettingsShell>
  );
}
