"use client";

/**
 * Legacy /sessions/[id] permalink — resolves the session's agent, then lands
 * on /agents/[username]/chats/[id]. Kept forever: task-run links, exports,
 * and old bookmarks all mint this shape, and the agent is unknowable without
 * a fetch. Streaming handoffs never pass through here (new chats navigate
 * straight to the agent-scoped permalink).
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";
import { sessionAgents } from "@/components/chat/chat-api";
import { getLastAgent } from "@/lib/last-agent";

export function SessionRedirect({ routeId }: { routeId: string }) {
  const router = useRouter();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const detail = await api.sessions.get(routeId);
        if (cancelled) return;
        const agent =
          sessionAgents(detail.session)[0]?.username ?? getLastAgent();
        if (agent) {
          router.replace(
            `/agents/${encodeURIComponent(agent)}/chats/${encodeURIComponent(detail.session.id)}`,
          );
        } else {
          setFailed(true);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [routeId, router]);

  if (failed) {
    return (
      <div className="flex h-dvh items-center justify-center px-6">
        <EmptyState
          title="Couldn't open this conversation"
          hint="It may have been deleted, or you may not have access."
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

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col px-6 py-10 md:px-10" aria-busy>
      <div className="flex items-center gap-3">
        <Skeleton className="size-8 rounded-full" />
        <Skeleton className="h-4 w-40" />
      </div>
      <div className="mt-10 space-y-6">
        <Skeleton className="ml-auto h-10 w-3/5 rounded-xl" />
        <div className="space-y-2">
          <Skeleton className="h-3.5 w-4/5" />
          <Skeleton className="h-3.5 w-3/5" />
        </div>
      </div>
    </div>
  );
}
