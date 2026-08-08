import type { Metadata } from "next";
import { SessionConversation } from "@/components/chat/conversation";

export const metadata: Metadata = { title: "Session" };

/**
 * /agents/[username]/chats/[id] — the conversation view, agent-scoped. `id`
 * is a uuid or a legacy 24-hex permalink id (the API resolves both). Keyed so
 * navigating between sessions remounts the client surface cleanly.
 */
export default async function AgentSessionPage({
  params,
}: {
  params: Promise<{ username: string; id: string }>;
}) {
  const { username, id } = await params;
  const decoded = decodeURIComponent(id);
  return (
    <SessionConversation
      key={decoded}
      routeId={decoded}
      backHref={`/agents/${username}/chats`}
    />
  );
}
