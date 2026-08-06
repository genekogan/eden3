"use client";

/**
 * Directory card: avatar, name/@handle, two-line description, session count
 * (when the api provides one), pilot badge, Chat action. The whole card is a
 * stretched link to the profile; Chat sits above it (z-10) and deep-links
 * into a new chat with the agent preselected.
 */

import Link from "next/link";
import { AgentAvatar } from "@/components/agent-avatar";
import { PilotBadge, PrivateBadge, ProvisionBadge } from "@/components/agents/badges";
import { sessionCountOf } from "@/components/agents/agent-utils";
import type { AgentDto } from "@/lib/types";

export function chatHref(username: string): string {
  return `/agents/${encodeURIComponent(username)}/chats/new`;
}

export function agentHref(username: string, sub?: string): string {
  return `/agents/${encodeURIComponent(username)}${sub ? `/${sub}` : ""}`;
}

export function AgentCard({ agent }: { agent: AgentDto }) {
  const sessions = sessionCountOf(agent);
  const displayName = agent.name?.trim() || agent.username;

  return (
    <div className="group relative flex flex-col rounded-xl border border-edge bg-surface p-4 transition-colors hover:border-accent/40">
      <Link
        href={agentHref(agent.username)}
        aria-label={`${displayName} — profile`}
        className="absolute inset-0 rounded-xl"
      />

      <div className="flex items-start gap-3">
        <AgentAvatar account={agent} size={44} />
        <div className="min-w-0 flex-1 pt-0.5">
          <p className="truncate text-sm font-medium text-foreground">
            {displayName}
          </p>
          <p className="truncate font-mono text-xs text-faint">
            @{agent.username}
          </p>
        </div>
        {agent.public === false ? <PrivateBadge /> : null}
        {agent.isPilot ? <PilotBadge /> : null}
      </div>

      <p className="mt-3 line-clamp-2 min-h-10 text-sm leading-5 text-muted">
        {agent.description?.trim() || (
          <span className="text-faint">No description yet.</span>
        )}
      </p>

      <div className="mt-4 flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2 text-xs tabular-nums text-faint">
          <ProvisionBadge status={agent.provisionStatus} />
          {sessions !== null ? (
            <span className="truncate">
              {sessions.toLocaleString("en-US")}{" "}
              {sessions === 1 ? "session" : "sessions"}
            </span>
          ) : null}
        </span>
        <Link
          href={chatHref(agent.username)}
          className="relative z-10 rounded-lg border border-accent/40 px-3 py-1.5 text-xs font-medium text-accent-soft transition-colors hover:bg-accent/10"
        >
          Chat
        </Link>
      </div>
    </div>
  );
}
