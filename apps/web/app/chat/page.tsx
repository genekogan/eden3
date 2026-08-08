import { redirectToAgentSub } from "@/lib/last-agent-server";

/**
 * Legacy /chat[?agent=<username>] — chats are agent-scoped now. An explicit
 * ?agent= wins; otherwise the remembered agent; otherwise the selector.
 */
export default async function LegacyChatPage({
  searchParams,
}: {
  searchParams: Promise<{ agent?: string }>;
}) {
  const { agent } = await searchParams;
  await redirectToAgentSub("chats", agent);
}
