import { redirectToAgentSub } from "@/lib/last-agent-server";

/** Home → the remembered agent's chats, or the agent selector. */
export default async function HomePage() {
  await redirectToAgentSub("chats");
}
