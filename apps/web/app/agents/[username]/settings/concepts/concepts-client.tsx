"use client";

import { AgentConceptsPanel } from "@/components/agents/agent-concepts";
import { useSelectedAgent } from "@/components/shell/selected-agent-context";

export function ConceptsSettings({ username }: { username: string }) {
  const { agent, canManage } = useSelectedAgent();
  return (
    <AgentConceptsPanel
      username={username}
      agentName={agent?.name?.trim() || username}
      canManage={canManage}
    />
  );
}
