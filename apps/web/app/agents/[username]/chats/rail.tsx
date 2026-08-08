"use client";

import { SessionRail } from "@/components/chat/session-rail";

const base = (username: string) => `/agents/${encodeURIComponent(username)}/chats`;

/** Desktop rail (hidden on mobile — the index page carries the list there). */
export function AgentChatsRail({ username }: { username: string }) {
  return (
    <SessionRail
      agent={username}
      basePath={base(username)}
      newChatHref={`${base(username)}/new`}
      className="hidden w-72 shrink-0 border-r border-edge bg-surface/60 md:flex"
    />
  );
}

/** Mobile: the conversations list as the chats index page. */
export function AgentChatsMobileList({ username }: { username: string }) {
  return (
    <SessionRail
      agent={username}
      basePath={base(username)}
      newChatHref={`${base(username)}/new`}
      className="flex w-full md:hidden"
    />
  );
}
