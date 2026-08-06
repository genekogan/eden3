import { redirect } from "next/navigation";

/** /agents/[username] → the agent's chats (its home surface). */
export default async function AgentIndexPage({
  params,
}: {
  params: Promise<{ username: string }>;
}) {
  const { username } = await params;
  redirect(`/agents/${username}/chats`);
}
