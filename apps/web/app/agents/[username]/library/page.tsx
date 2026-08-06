import type { Metadata } from "next";
import { SectionPlaceholder } from "@/components/shell/section-placeholder";

export const metadata: Metadata = { title: "Library" };

export default function AgentLibraryPage() {
  return (
    <SectionPlaceholder
      title="Library"
      description="Everything this agent has created — with a toggle to view creations across all your agents."
      legacyHref="/explore?agent={username}"
      legacyLabel="Open the legacy feed filtered to this agent"
    />
  );
}
