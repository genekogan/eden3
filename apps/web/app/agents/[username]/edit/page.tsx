import { redirect } from "next/navigation";

/** Legacy /agents/[username]/edit → Settings › Identity. */
export default async function LegacyAgentEditPage({
  params,
}: {
  params: Promise<{ username: string }>;
}) {
  const { username } = await params;
  redirect(`/agents/${username}/settings/identity`);
}
