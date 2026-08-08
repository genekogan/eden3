"use client";

import { AgentMemoryPanel } from "@/components/agents/agent-profile";
import { useSelectedAgent } from "@/components/shell/selected-agent-context";

export function MemorySettings({ username }: { username: string }) {
  const { canManage } = useSelectedAgent();
  return <AgentMemoryPanel username={username} seed={null} canManage={canManage} />;
}
