import type { Metadata } from "next";
import { SectionPlaceholder } from "@/components/shell/section-placeholder";

export const metadata: Metadata = { title: "Log" };

export default function AgentLogPage() {
  return (
    <SectionPlaceholder
      title="Log"
      description="This agent's activity and metered usage — with a toggle to view spend across all your agents."
      legacyHref="/usage"
      legacyLabel="Open legacy Usage"
    />
  );
}
