import { redirectToAgentSub } from "@/lib/last-agent-server";

/** Legacy /sessions — conversations are agent-scoped now (/agents/[u]/chats). */
export default async function LegacySessionsPage() {
  await redirectToAgentSub("chats");
}
