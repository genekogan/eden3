"use client";

import { AgentWorkspacePanel } from "@/components/agents/agent-workspace";
import { useSelectedAgent } from "@/components/shell/selected-agent-context";

export function WorkspaceClient({ username }: { username: string }) {
  const { canManage } = useSelectedAgent();
  return <AgentWorkspacePanel username={username} canManage={canManage} />;
}
