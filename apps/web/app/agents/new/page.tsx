import type { Metadata } from "next";
import { AgentCreateForm } from "@/components/agents/agent-create-form";

export const metadata: Metadata = { title: "Create agent" };

export default function NewAgentPage() {
  return <AgentCreateForm />;
}
