"use client";

/**
 * Guard for /agents/[username]/… — gates children on the selected agent
 * actually loading. Unknown agent → clear the remembered-agent cookie (so
 * bare-route redirects stop bouncing here) and offer the selector.
 */

import Link from "next/link";
import { useEffect } from "react";
import type { ReactNode } from "react";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";
import { clearLastAgent, getLastAgent } from "@/lib/last-agent";
import { useSelectedAgent } from "./selected-agent-context";

export function AgentScope({ children }: { children: ReactNode }) {
  const { username, agent, phase, refresh } = useSelectedAgent();

  // A dead remembered agent would loop every bare-route redirect back into
  // this error state — forget it as soon as we learn it is gone.
  useEffect(() => {
    if (phase === "missing" && username && getLastAgent() === username) {
      clearLastAgent();
    }
  }, [phase, username]);

  if (phase === "missing") {
    return (
      <div className="flex h-dvh items-center justify-center px-6">
        <EmptyState
          title={`No agent called “${username}”`}
          hint="It may have been renamed, deleted, or belong to someone else."
          action={
            <Link
              href="/agents"
              className="rounded-lg border border-edge px-3.5 py-2 text-sm text-muted transition-colors hover:border-accent/50 hover:text-foreground"
            >
              Your agents
            </Link>
          }
          className="w-full max-w-md"
        />
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="flex h-dvh items-center justify-center px-6">
        <EmptyState
          title="Couldn't load this agent"
          hint="The API may be unreachable."
          action={
            <button
              type="button"
              onClick={refresh}
              className="rounded-lg border border-edge px-3.5 py-2 text-sm text-muted transition-colors hover:border-accent/50 hover:text-foreground"
            >
              Try again
            </button>
          }
          className="w-full max-w-md"
        />
      </div>
    );
  }

  if (phase === "loading" && !agent) {
    return (
      <div className="px-6 py-10 md:px-10" aria-busy>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="mt-4 h-4 w-72" />
        <Skeleton className="mt-8 h-40 w-full max-w-2xl" />
      </div>
    );
  }

  return <>{children}</>;
}
