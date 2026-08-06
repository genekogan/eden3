import type { Metadata } from "next";
import { SettingsShell } from "@/components/agents/settings/settings-shell";
import { ConceptsSettings } from "./concepts-client";

export const metadata: Metadata = { title: "Concepts · Settings" };

export default async function AgentConceptsSettingsPage({
  params,
}: {
  params: Promise<{ username: string }>;
}) {
  const { username } = await params;
  const decoded = decodeURIComponent(username);
  return (
    <SettingsShell
      username={decoded}
      title="Concepts"
      hint="Reference-image concepts the agent can lean on when creating."
    >
      <ConceptsSettings username={decoded} />
    </SettingsShell>
  );
}
