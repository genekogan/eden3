import type { Metadata } from "next";
import { SectionPlaceholder } from "@/components/shell/section-placeholder";

export const metadata: Metadata = { title: "Workspace" };

export default function AgentWorkspacePage() {
  return (
    <SectionPlaceholder
      title="Workspace"
      description="The agent's raw file tree — personas, memory, notes, everything it works with."
      legacyHref="/agents/{username}/profile"
      legacyLabel="Open the Files tab on the legacy profile"
    />
  );
}
