import { redirectToAgentSub } from "@/lib/last-agent-server";

/** Legacy /channels[?agent=] — now the agent-scoped Gateway. */
export default async function LegacyChannelsPage({
  searchParams,
}: {
  searchParams: Promise<{ agent?: string }>;
}) {
  const { agent } = await searchParams;
  await redirectToAgentSub("gateway", agent?.replace(/^@/, ""));
}
