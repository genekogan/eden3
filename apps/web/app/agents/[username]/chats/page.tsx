import type { Metadata } from "next";
import { AgentChatComposer } from "@/components/chat/new-chat";
import { AgentChatsMobileList } from "./rail";

export const metadata: Metadata = { title: "Chats" };

/**
 * /agents/[username]/chats — desktop shows the composer beside the layout's
 * rail; on mobile the list IS the page (composer lives at ./new).
 */
export default async function AgentChatsIndexPage({
  params,
}: {
  params: Promise<{ username: string }>;
}) {
  const { username } = await params;
  const decoded = decodeURIComponent(username);
  return (
    <>
      <AgentChatsMobileList username={decoded} />
      <div className="hidden h-full md:block">
        <AgentChatComposer username={decoded} />
      </div>
    </>
  );
}
