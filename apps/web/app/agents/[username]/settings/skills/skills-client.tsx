"use client";

import { AgentSkillsPanel } from "@/components/agents/agent-profile";
import { useSelectedAgent } from "@/components/shell/selected-agent-context";

export function SkillsSettings({ username }: { username: string }) {
  const { canManage } = useSelectedAgent();
  return <AgentSkillsPanel username={username} canManage={canManage} />;
}
