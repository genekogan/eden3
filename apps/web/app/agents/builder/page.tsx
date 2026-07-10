import type { Metadata } from "next";
import { AgentBuilder } from "@/components/agents/agent-builder";

export const metadata: Metadata = { title: "Agent Builder" };

export default function AgentBuilderPage() {
  return <AgentBuilder />;
}
