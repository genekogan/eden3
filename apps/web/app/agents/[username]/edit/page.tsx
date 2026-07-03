import type { Metadata } from "next";
import { AgentEditForm } from "@/components/agents/agent-edit-form";

interface Params {
  params: Promise<{ username: string }>;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { username } = await params;
  return { title: `Edit @${decodeURIComponent(username)}` };
}

export default async function AgentEditPage({ params }: Params) {
  const { username } = await params;
  return <AgentEditForm username={decodeURIComponent(username)} />;
}
