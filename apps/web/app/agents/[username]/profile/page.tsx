import type { Metadata } from "next";
import { AgentProfile } from "@/components/agents/agent-profile";

interface Params {
  params: Promise<{ username: string }>;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { username } = await params;
  const decoded = decodeURIComponent(username);
  return {
    title: `@${decoded}`,
    description: `Chat with @${decoded} and browse its creations on Eden3.`,
  };
}

export default async function AgentProfilePage({ params }: Params) {
  const { username } = await params;
  return <AgentProfile username={decodeURIComponent(username)} />;
}
