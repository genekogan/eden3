import type { Metadata } from "next";
import { SectionPlaceholder } from "@/components/shell/section-placeholder";

export const metadata: Metadata = { title: "Schedule" };

export default function AgentSchedulePage() {
  return (
    <SectionPlaceholder
      title="Schedule"
      description="This agent's recurring tasks and routines — active, paused, and finished."
      legacyHref="/tasks"
      legacyLabel="Open legacy Tasks"
    />
  );
}
