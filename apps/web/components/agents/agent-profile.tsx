"use client";

/**
 * /agents/[username] — agent profile.
 *
 * Header (avatar, name, @handle, description, owner, Chat CTA, Edit when the
 * impersonated dev user owns the agent) + two tabs:
 *   Creations — GET /api/feed/creations?agent= (cursor pagination), seeded
 *               from the profile's recentCreations while/if the feed lands.
 *   About     — persona (only when public or owner — it's the agent's system
 *               prompt), greeting, meta.
 *
 * While provisionStatus is pending/provisioning (fresh POST /api/agents) the
 * page polls the profile until the runtime is ready — the create form
 * redirects here and this indicator carries the wait.
 */

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, isEndpointMissing } from "@/lib/api";
import type { AgentDto, CreationDto, DevUser } from "@/lib/types";
import { AgentAvatar } from "@/components/agent-avatar";
import { EmptyState } from "@/components/empty-state";
import { MediaThumb } from "@/components/media";
import { Skeleton, SkeletonMediaGrid, SkeletonText } from "@/components/skeleton";
import { PilotBadge, ProvisionBadge } from "@/components/agents/badges";
import { agentHref, chatHref } from "@/components/agents/agent-card";
import {
  dedupeById,
  describeApiFailure,
  embeddedOwner,
  isPersonaPublic,
  isProvisionFailed,
  isProvisionPending,
  PROVISION_POLL_MAX,
  PROVISION_POLL_MS,
} from "@/components/agents/agent-utils";
import {
  primaryButtonClass,
  quietButtonClass,
} from "@/components/agents/form-fields";
import { formatDate } from "@/lib/format";

// ---------------------------------------------------------------------------
// Creations tab
// ---------------------------------------------------------------------------

function CreationTile({ creation }: { creation: CreationDto }) {
  return (
    <Link
      href={`/creations/${encodeURIComponent(creation.id)}`}
      className="group relative block overflow-hidden rounded-xl transition-opacity hover:opacity-90"
    >
      <MediaThumb creation={creation} />
    </Link>
  );
}

function AgentCreations({
  username,
  seed,
}: {
  username: string;
  seed: CreationDto[];
}) {
  const [items, setItems] = useState<CreationDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "seeded" | "error">(
    "loading",
  );
  const [errorText, setErrorText] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const id = ++seq.current;
    setState("loading");
    void (async () => {
      try {
        const page = await api.feed.creations({ agent: username });
        if (seq.current !== id) return;
        setItems(page.items);
        setCursor(page.nextCursor);
        setState("ready");
      } catch (error) {
        if (seq.current !== id) return;
        if (seed.length > 0) {
          // The profile endpoint already gave us recent work — show it.
          setItems(seed);
          setCursor(null);
          setState("seeded");
        } else {
          setErrorText(describeApiFailure(error));
          setState("error");
        }
      }
    })();
    // seed is captured from the profile response; username drives identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username]);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.feed.creations({ agent: username, cursor });
      setItems((prev) => dedupeById([...prev, ...page.items]));
      setCursor(page.nextCursor);
    } catch {
      setCursor(null); // quiet stop — the grid stays
    } finally {
      setLoadingMore(false);
    }
  };

  if (state === "loading") return <SkeletonMediaGrid count={8} />;

  if (state === "error") {
    return <EmptyState title="Couldn't load creations" hint={errorText} />;
  }

  if (items.length === 0) {
    return (
      <EmptyState
        title="No creations yet"
        hint="Work made in chats and the studio lands here."
        action={
          <Link href={chatHref(username)} className={quietButtonClass}>
            Start a chat
          </Link>
        }
      />
    );
  }

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {items.map((creation) => (
          <CreationTile key={creation.id} creation={creation} />
        ))}
      </div>
      {state === "seeded" ? (
        <p className="mt-4 text-center text-xs text-faint">
          Showing recent creations — the full feed endpoint hasn't landed yet.
        </p>
      ) : null}
      {cursor ? (
        <div className="mt-8 flex justify-center">
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className={quietButtonClass}
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// About tab
// ---------------------------------------------------------------------------

function AboutSection({
  agent,
  isOwner,
}: {
  agent: AgentDto;
  isOwner: boolean;
}) {
  const personaVisible = isPersonaPublic(agent) || isOwner;
  const greeting = agent.greeting?.trim();
  const persona = agent.persona?.trim();

  return (
    <div className="max-w-2xl space-y-8">
      <section>
        <h2 className="font-mono text-[11px] uppercase tracking-[0.25em] text-faint">
          Greeting
        </h2>
        {greeting ? (
          <blockquote className="mt-3 rounded-xl border border-edge bg-surface p-5 text-sm leading-relaxed text-foreground">
            “{greeting}”
          </blockquote>
        ) : (
          <p className="mt-3 text-sm text-faint">
            No greeting yet — this agent opens chats silently.
          </p>
        )}
      </section>

      <section>
        <h2 className="font-mono text-[11px] uppercase tracking-[0.25em] text-faint">
          Persona
        </h2>
        {!personaVisible ? (
          <p className="mt-3 text-sm text-faint">
            This agent's persona is private.
          </p>
        ) : persona ? (
          <div className="mt-3 whitespace-pre-wrap rounded-xl border border-edge bg-surface p-5 font-mono text-[13px] leading-relaxed text-muted">
            {persona}
          </div>
        ) : (
          <p className="mt-3 text-sm text-faint">
            No persona yet.
            {isOwner ? (
              <>
                {" "}
                <Link
                  href={agentHref(agent.username, "edit")}
                  className="text-accent-soft hover:underline"
                >
                  Write one
                </Link>{" "}
                — it applies to the very next message.
              </>
            ) : null}
          </p>
        )}
        {personaVisible && persona && isOwner && !isPersonaPublic(agent) ? (
          <p className="mt-2 text-xs text-faint">
            Only you can see this — the persona isn't public.
          </p>
        ) : null}
      </section>

      <section className="flex flex-wrap gap-x-8 gap-y-2 border-t border-edge pt-5 text-xs text-faint">
        <span>Created {formatDate(agent.createdAt)}</span>
        <span>{agent.public ? "Public" : "Private"} agent</span>
        {agent.voice ? <span>Voice: {agent.voice}</span> : null}
        {agent.isSynthetic ? <span>Synthetic</span> : null}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Profile page body
// ---------------------------------------------------------------------------

type ProfileState =
  | { kind: "loading" }
  | { kind: "not-found" }
  | { kind: "error"; endpointMissing: boolean; text: string }
  | { kind: "ready" };

function ProfileSkeleton() {
  return (
    <div aria-hidden>
      <div className="flex items-start gap-5">
        <Skeleton className="size-20 rounded-full" />
        <div className="flex-1 space-y-3 pt-1">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-3.5 w-28" />
          <SkeletonText lines={2} className="max-w-md pt-1" />
        </div>
      </div>
      <Skeleton className="mt-10 h-px w-full" />
      <SkeletonMediaGrid count={8} className="mt-6" />
    </div>
  );
}

export function AgentProfile({ username }: { username: string }) {
  const [profile, setProfile] = useState<{
    agent: AgentDto;
    recentCreations: CreationDto[];
  } | null>(null);
  const [state, setState] = useState<ProfileState>({ kind: "loading" });
  const [me, setMe] = useState<DevUser | null>(null);
  const [tab, setTab] = useState<"creations" | "about">("creations");
  const [reloadKey, setReloadKey] = useState(0);
  const seq = useRef(0);

  // Load profile + current dev user (owner gating) in parallel.
  useEffect(() => {
    const id = ++seq.current;
    setState({ kind: "loading" });
    void (async () => {
      try {
        const data = await api.agents.get(username);
        if (seq.current !== id) return;
        setProfile(data);
        setState({ kind: "ready" });
      } catch (error) {
        if (seq.current !== id) return;
        if (error instanceof ApiError && error.status === 404) {
          setState({ kind: "not-found" });
        } else {
          setState({
            kind: "error",
            endpointMissing: isEndpointMissing(error),
            text: describeApiFailure(error),
          });
        }
      }
    })();
    void api.dev.me().then(
      (user) => {
        if (seq.current === id) setMe(user);
      },
      () => {
        if (seq.current === id) setMe(null);
      },
    );
  }, [username, reloadKey]);

  // Poll while the runtime is being provisioned (fresh agents land here
  // straight from the create form).
  const provisionStatus = profile?.agent.provisionStatus;
  useEffect(() => {
    if (!isProvisionPending(provisionStatus)) return;
    let tries = 0;
    const timer = window.setInterval(async () => {
      tries += 1;
      if (tries > PROVISION_POLL_MAX) {
        window.clearInterval(timer);
        return;
      }
      try {
        const data = await api.agents.get(username);
        setProfile((prev) =>
          prev && prev.agent.username === data.agent.username ? data : prev,
        );
      } catch {
        // transient — keep polling until the cap
      }
    }, PROVISION_POLL_MS);
    return () => window.clearInterval(timer);
  }, [provisionStatus, username]);

  if (state.kind === "loading") {
    return (
      <div className="mx-auto w-full max-w-5xl px-6 py-10 md:px-10">
        <ProfileSkeleton />
      </div>
    );
  }

  if (state.kind === "not-found") {
    return (
      <div className="mx-auto w-full max-w-5xl px-6 py-10 md:px-10">
        <EmptyState
          title={`No agent named @${username}`}
          hint="It may have been renamed, or never existed."
          action={
            <Link href="/agents" className={quietButtonClass}>
              Browse agents
            </Link>
          }
        />
      </div>
    );
  }

  if (state.kind === "error" || !profile) {
    const text = state.kind === "error" ? state.text : "";
    const endpointMissing = state.kind === "error" && state.endpointMissing;
    return (
      <div className="mx-auto w-full max-w-5xl px-6 py-10 md:px-10">
        <EmptyState
          title={
            endpointMissing
              ? "Agent profiles aren't wired up yet"
              : `Couldn't load @${username}`
          }
          hint={text}
          action={
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              className={quietButtonClass}
            >
              Try again
            </button>
          }
        />
      </div>
    );
  }

  const { agent, recentCreations } = profile;
  const isOwner = me !== null && agent.ownerId !== null && me.id === agent.ownerId;
  const owner = embeddedOwner(agent);
  const displayName = agent.name?.trim() || agent.username;
  const pending = isProvisionPending(agent.provisionStatus);
  const failed = isProvisionFailed(agent.provisionStatus);
  const chatBlocked = pending || failed;

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10 md:px-10">
      {/* Header */}
      <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
        <AgentAvatar account={agent} size={80} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-2xl font-light tracking-tight md:text-3xl">
              {displayName}
            </h1>
            {agent.isPilot ? <PilotBadge /> : null}
            <ProvisionBadge status={agent.provisionStatus} />
          </div>
          <p className="mt-1 font-mono text-sm text-faint">@{agent.username}</p>
          {agent.description?.trim() ? (
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
              {agent.description}
            </p>
          ) : null}
          <p className="mt-2 text-xs text-faint">
            {isOwner
              ? "Owned by you"
              : owner
                ? `By @${owner.username}`
                : agent.ownerId
                  ? "Community agent"
                  : "Eden agent"}
          </p>

          <div className="mt-5 flex flex-wrap items-center gap-2.5">
            {chatBlocked ? (
              <span
                aria-disabled
                title={
                  failed
                    ? "Provisioning failed — chat is unavailable"
                    : "Chat unlocks once provisioning completes"
                }
                className={`${primaryButtonClass} cursor-not-allowed opacity-50`}
              >
                Chat
              </span>
            ) : (
              <Link href={chatHref(agent.username)} className={primaryButtonClass}>
                Chat
              </Link>
            )}
            {isOwner ? (
              <Link
                href={agentHref(agent.username, "edit")}
                className={quietButtonClass}
              >
                Edit
              </Link>
            ) : null}
          </div>
        </div>
      </div>

      {/* Provisioning banner (post-create wait) */}
      {pending ? (
        <div className="mt-8 flex items-center gap-3 rounded-xl border border-accent/25 bg-accent/5 px-4 py-3 text-sm text-muted">
          <span aria-hidden className="size-2 shrink-0 animate-pulse rounded-full bg-accent" />
          Setting up this agent's runtime — chat unlocks the moment it's ready.
        </div>
      ) : failed ? (
        <div className="mt-8 rounded-xl border border-red-400/25 bg-red-400/5 px-4 py-3 text-sm text-muted">
          Provisioning failed. The agent's profile and persona are saved — try
          again later or contact an admin.
        </div>
      ) : null}

      {/* Tabs */}
      <div role="tablist" aria-label="Agent sections" className="mt-10 flex gap-6 border-b border-edge">
        {(["creations", "about"] as const).map((key) => (
          <button
            key={key}
            role="tab"
            type="button"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`-mb-px border-b-2 px-1 pb-2.5 text-sm capitalize transition-colors ${
              tab === key
                ? "border-accent text-foreground"
                : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            {key}
          </button>
        ))}
      </div>

      <div className="mt-6">
        {tab === "creations" ? (
          <AgentCreations username={agent.username} seed={recentCreations} />
        ) : (
          <AboutSection agent={agent} isOwner={isOwner} />
        )}
      </div>
    </div>
  );
}
