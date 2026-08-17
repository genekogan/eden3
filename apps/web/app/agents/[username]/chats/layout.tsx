import type { ReactNode } from "react";
import { AgentChatsRail } from "./rail";

/**
 * /agents/[username]/chats — the agent's conversations: rail beside the
 * conversation (or the new-chat composer at the index). Collapses on small
 * screens like the old /sessions shell.
 */
export default async function AgentChatsLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ username: string }>;
}) {
  const { username } = await params;
  return (
    <div className="flex h-[calc(100dvh-3.5rem-var(--eden-safe-top)-var(--eden-safe-bottom))] min-w-0 sm:h-[calc(100dvh-var(--eden-safe-top)-var(--eden-safe-bottom))]">
      <AgentChatsRail username={decodeURIComponent(username)} />
      <div className="h-full min-w-0 flex-1">{children}</div>
    </div>
  );
}
