import type { ReactNode } from "react";
import { AgentScope } from "@/components/shell/agent-scope";

/**
 * /agents/[username]/… — the agent-scoped section. The username lives in the
 * URL; the shell's SelectedAgentProvider reads it from the pathname, so this
 * layout only mounts the client guard.
 */
export default function AgentScopedLayout({ children }: { children: ReactNode }) {
  return <AgentScope>{children}</AgentScope>;
}
