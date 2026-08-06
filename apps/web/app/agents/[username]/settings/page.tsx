import type { Metadata } from "next";
import { SectionPlaceholder } from "@/components/shell/section-placeholder";

export const metadata: Metadata = { title: "Agent Settings" };

export default function AgentSettingsPage() {
  return (
    <SectionPlaceholder
      title="Settings"
      description="This agent's identity, persona, tools, skills, and memory — organized hierarchically."
      legacyHref="/agents/{username}/edit"
      legacyLabel="Open the legacy edit form"
    />
  );
}
