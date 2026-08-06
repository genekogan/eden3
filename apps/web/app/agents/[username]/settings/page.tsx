import { redirect } from "next/navigation";

/** /agents/[username]/settings → Identity (the first section). */
export default async function AgentSettingsIndexPage({
  params,
}: {
  params: Promise<{ username: string }>;
}) {
  const { username } = await params;
  redirect(`/agents/${username}/settings/identity`);
}
