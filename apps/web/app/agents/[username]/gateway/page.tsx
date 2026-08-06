import type { Metadata } from "next";
import { SectionPlaceholder } from "@/components/shell/section-placeholder";

export const metadata: Metadata = { title: "Gateway" };

export default function AgentGatewayPage() {
  return (
    <SectionPlaceholder
      title="Gateway"
      description="The agent's connections to the outside world — Discord and Telegram links, pairing requests, allowlists, and delivery settings."
      legacyHref="/channels?agent={username}"
      legacyLabel="Open legacy Channels for this agent"
    />
  );
}
