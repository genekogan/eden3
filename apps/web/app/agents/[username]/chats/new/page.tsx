import type { Metadata } from "next";
import { AgentChatComposer } from "@/components/chat/new-chat";

export const metadata: Metadata = { title: "New Chat" };

/** /agents/[username]/chats/new — compose the first message to this agent. */
export default async function AgentNewChatPage({
  params,
}: {
  params: Promise<{ username: string }>;
}) {
  const { username } = await params;
  return <AgentChatComposer username={decodeURIComponent(username)} />;
}
