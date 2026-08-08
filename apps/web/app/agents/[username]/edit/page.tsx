import { redirect } from "next/navigation";
import { agentSettingsLandingHref } from "@/lib/eve";

/** Legacy /agents/[username]/edit → Settings › Identity. */
export default async function LegacyAgentEditPage({
  params,
}: {
  params: Promise<{ username: string }>;
}) {
  const { username } = await params;
  redirect(agentSettingsLandingHref(decodeURIComponent(username)));
}
