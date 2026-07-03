import type { Metadata } from "next";
import { SessionConversation } from "@/components/chat/conversation";

export const metadata: Metadata = { title: "Session" };

/**
 * /sessions/[id] — full conversation view. `id` is a uuid, or a legacy
 * 24-hex Mongo id on old permalinks (the API resolves both). Keyed so
 * navigating between sessions remounts the client surface cleanly.
 */
export default async function SessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const decoded = decodeURIComponent(id);
  return <SessionConversation key={decoded} routeId={decoded} />;
}
