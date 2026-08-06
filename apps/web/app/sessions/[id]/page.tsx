import type { Metadata } from "next";
import { SessionRedirect } from "./session-redirect";

export const metadata: Metadata = { title: "Session" };

/**
 * Legacy /sessions/[id] — permanent redirector to the agent-scoped
 * conversation (/agents/[username]/chats/[id]). See session-redirect.tsx.
 */
export default async function LegacySessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <SessionRedirect routeId={decodeURIComponent(id)} />;
}
