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
import type {
  AgentDto,
  AgentMemorySnapshot,
  AgentProfile as AgentProfileResponse,
  AgentSkillDto,
  CreationDto,
  DevUser,
  SkillDefinitionDto,
} from "@/lib/types";
import { AgentAvatar } from "@/components/agent-avatar";
import { EmptyState } from "@/components/empty-state";
import { MediaThumb } from "@/components/media";
import {
  Skeleton,
  SkeletonMediaGrid,
  SkeletonRows,
  SkeletonText,
} from "@/components/skeleton";
import { PilotBadge, ProvisionBadge } from "@/components/agents/badges";
import { AgentConceptsPanel } from "@/components/agents/agent-concepts";
import { AgentWorkspacePanel } from "@/components/agents/agent-workspace";
import { agentHref, chatHref } from "@/components/agents/agent-card";
import {
  dedupeById,
  describeApiFailure,
  embeddedOwner,
  isPersonaPublic,
  isProvisionFailed,
  isProvisionPending,
  isProvisionQueued,
  isProvisionWarming,
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
      className="group relative block aspect-square min-w-0 overflow-hidden rounded-xl transition-opacity hover:opacity-90"
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
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4">
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
    <div className="max-w-2xl min-w-0 space-y-8">
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
          <div className="mt-3 whitespace-pre-wrap break-words rounded-xl border border-edge bg-surface p-4 font-mono text-[13px] leading-relaxed text-muted [overflow-wrap:anywhere] sm:p-5">
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
// Skills tab
// ---------------------------------------------------------------------------

function skillBadgeClass(status: string): string {
  if (status === "approved") {
    return "border-emerald-400/25 bg-emerald-400/10 text-emerald-300";
  }
  if (status === "rejected") {
    return "border-rose-400/25 bg-rose-400/10 text-rose-300";
  }
  return "border-amber-400/25 bg-amber-400/10 text-amber-300";
}

function InstalledSkill({ skill }: { skill: AgentSkillDto }) {
  return (
    <article className="min-w-0 rounded-xl border border-edge bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium text-foreground">{skill.name}</h3>
        <span className={`rounded-full border px-2 py-0.5 text-[11px] ${skillBadgeClass(skill.status)}`}>
          {skill.status}
        </span>
      </div>
      <p className="mt-1 break-all font-mono text-xs text-faint">{skill.slug}</p>
      {skill.description ? (
        <p className="mt-3 text-sm leading-relaxed text-muted">{skill.description}</p>
      ) : null}
    </article>
  );
}

export function AgentSkillsPanel({
  username,
  canManage,
}: {
  username: string;
  canManage: boolean;
}) {
  const [attached, setAttached] = useState<AgentSkillDto[]>([]);
  const [available, setAvailable] = useState<SkillDefinitionDto[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [errorText, setErrorText] = useState("");
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const id = ++seq.current;
    setPhase("loading");
    void (async () => {
      try {
        const data = await api.skills.agent(username);
        if (seq.current !== id) return;
        setAttached(data.attached);
        setAvailable((data.available ?? []).filter((skill) => skill.status === "approved"));
        setSelected(new Set(data.attached.filter((skill) => skill.enabled).map((skill) => skill.slug)));
        setPhase("ready");
      } catch (error) {
        if (seq.current !== id) return;
        setErrorText(describeApiFailure(error));
        setPhase("error");
      }
    })();
  }, [username]);

  const save = async () => {
    setSaving(true);
    setNote(null);
    try {
      const data = await api.skills.setAgent(username, [...selected].sort());
      setAttached(data.skills ?? data.attached);
      setAvailable((data.available ?? available).filter((skill) => skill.status === "approved"));
      setSelected(new Set((data.skills ?? data.attached).filter((skill) => skill.enabled).map((skill) => skill.slug)));
      setNote("Skills updated.");
    } catch (error) {
      setNote(describeApiFailure(error));
    } finally {
      setSaving(false);
    }
  };

  if (phase === "loading") return <SkeletonRows count={4} />;
  if (phase === "error") return <EmptyState title="Couldn't load skills" hint={errorText} />;

  const manager = canManage && available.length > 0;

  if (!manager) {
    return attached.length === 0 ? (
      <EmptyState title="No installed skills" hint="This agent has no skill allowlist yet." />
    ) : (
      <div className="grid gap-3 md:grid-cols-2">
        {attached.map((skill) => (
          <InstalledSkill key={skill.id} skill={skill} />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {note ? (
        <p className="rounded-lg border border-accent/25 bg-accent/10 px-3 py-2 text-xs text-accent-soft">
          {note}
        </p>
      ) : null}
      <div className="grid gap-3 md:grid-cols-2">
        {available.map((skill) => {
          const checked = selected.has(skill.slug);
          return (
            <label
              key={skill.id}
              className={`block rounded-xl border p-4 transition-colors ${
                checked
                  ? "border-accent/50 bg-accent/10"
                  : "border-edge bg-surface hover:border-white/20"
              }`}
            >
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (next.has(skill.slug)) next.delete(skill.slug);
                      else next.add(skill.slug);
                      return next;
                    });
                  }}
                  className="mt-1 size-4"
                />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{skill.name}</p>
                  <p className="mt-1 break-all font-mono text-xs text-faint">{skill.slug}</p>
                  {skill.description ? (
                    <p className="mt-2 text-sm leading-relaxed text-muted">{skill.description}</p>
                  ) : null}
                </div>
              </div>
            </label>
          );
        })}
      </div>
      <button
        type="button"
        onClick={() => void save()}
        disabled={saving}
        className={primaryButtonClass}
      >
        {saving ? "Saving…" : "Save skills"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Memory tab
// ---------------------------------------------------------------------------

export function AgentMemoryPanel({
  username,
  seed,
  canManage,
}: {
  username: string;
  seed: AgentProfileResponse["memory"];
  canManage: boolean;
}) {
  const [snapshot, setSnapshot] = useState<AgentMemorySnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState<"save" | "rebuild" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [errorText, setErrorText] = useState("");
  const seq = useRef(0);

  useEffect(() => {
    if (!canManage) {
      setPhase("ready");
      return;
    }
    const id = ++seq.current;
    setPhase("loading");
    void (async () => {
      try {
        const data = await api.agents.memory(username);
        if (seq.current !== id) return;
        setSnapshot(data.memory);
        setDraft(data.memory.collective.content ?? "");
        setPhase("ready");
      } catch (error) {
        if (seq.current !== id) return;
        setErrorText(describeApiFailure(error));
        setPhase("error");
      }
    })();
  }, [canManage, username]);

  const save = async () => {
    setBusy("save");
    setNote(null);
    try {
      const data = await api.agents.saveMemory(username, draft);
      setSnapshot(data.memory);
      setDraft(data.memory.collective.content ?? "");
      setNote("Memory saved.");
    } catch (error) {
      setNote(describeApiFailure(error));
    } finally {
      setBusy(null);
    }
  };

  const rebuild = async () => {
    if (
      !window.confirm(
        "Force reseed from Eden history? This replaces collective and per-user seed files. Use this only when you intentionally want to discard later native/dream memory edits.",
      )
    ) return;
    setBusy("rebuild");
    setNote(null);
    try {
      const data = await api.agents.rebuildMemory(username);
      setNote(data.queued ? "Manual reseed queued." : "A memory operation is already running.");
    } catch (error) {
      setNote(describeApiFailure(error));
    } finally {
      setBusy(null);
    }
  };

  if (!canManage) {
    return <EmptyState title="Memory is private" hint="Only the owner can inspect this agent memory." />;
  }
  if (phase === "loading") return <SkeletonRows count={4} />;
  if (phase === "error") return <EmptyState title="Couldn't load memory" hint={errorText} />;

  const status = snapshot ?? seed;
  const rows = [
    ["Status", status?.status ?? "pending"],
    ["Messages", String(status?.messagesSampled ?? 0)],
    ["Chars", String(snapshot?.collective.chars ?? status?.memoryChars ?? 0)],
    ["Model", status?.model ?? "pending"],
  ];

  return (
    <div className="min-w-0 space-y-5">
      {note ? (
        <p className="rounded-lg border border-accent/25 bg-accent/10 px-3 py-2 text-xs text-accent-soft">
          {note}
        </p>
      ) : null}
      <div className="grid gap-3 text-xs text-faint sm:grid-cols-4">
        {rows.map(([label, value]) => (
          <div key={label} className="rounded-lg border border-edge bg-surface px-3 py-2">
            <p className="font-mono uppercase tracking-[0.18em]">{label}</p>
            <p className="mt-1 break-words text-sm text-muted">{value}</p>
          </div>
        ))}
      </div>
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        spellCheck={false}
        className="min-h-[360px] w-full max-w-full resize-y rounded-lg border border-edge bg-black/20 p-4 font-mono text-[13px] leading-relaxed text-muted outline-none transition-colors focus:border-accent/60"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy !== null || draft.trim() === ""}
          className={primaryButtonClass}
        >
          {busy === "save" ? "Saving…" : "Save owner correction"}
        </button>
        <button
          type="button"
          onClick={() => void rebuild()}
          disabled={busy !== null}
          className={quietButtonClass}
        >
          {busy === "rebuild" ? "Reseeding…" : "Force reseed from history"}
        </button>
      </div>
      {snapshot?.latestRevision ? (
        <p className="rounded-lg border border-edge bg-surface px-3 py-2 text-xs leading-relaxed text-faint">
          Latest provenance: <span className="text-muted">{snapshot.latestRevision.operation}</span>
          {" · "}{new Date(snapshot.latestRevision.createdAt).toLocaleString()}
          {" · "}<span className="font-mono">{snapshot.latestRevision.sha256.slice(0, 12)}</span>
        </p>
      ) : null}
      {snapshot?.userFiles.length ? (
        <section className="border-t border-edge pt-5">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.25em] text-faint">
            User Files
          </h2>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {snapshot.userFiles.map((file) => (
              <details key={file.filename} className="min-w-0 rounded-lg border border-edge bg-surface p-3">
                <summary className="cursor-pointer break-all font-mono text-xs text-muted">
                  {file.filename}
                </summary>
                <p className="mt-1 text-xs text-faint">{file.chars} chars</p>
                <pre className="mt-3 max-h-[320px] overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-muted">
                  {file.content}
                </pre>
              </details>
            ))}
          </div>
        </section>
      ) : null}
      {snapshot?.dreamDiary.content ? (
        <section className="border-t border-edge pt-5">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.25em] text-faint">
            Dream Diary
          </h2>
          <pre className="mt-3 max-h-[360px] overflow-auto whitespace-pre-wrap rounded-lg border border-edge bg-surface p-3 text-xs leading-relaxed text-muted">
            {snapshot.dreamDiary.content}
          </pre>
        </section>
      ) : null}
      {snapshot?.dreamReports.length ? (
        <section className="border-t border-edge pt-5">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.25em] text-faint">
            Deep / REM Reports
          </h2>
          <div className="mt-3 space-y-3">
            {snapshot.dreamReports.map((file) => (
              <details key={file.path} className="rounded-lg border border-edge bg-surface p-3">
                <summary className="cursor-pointer font-mono text-xs text-muted">
                  {file.phase.toUpperCase()} · {file.filename}
                </summary>
                <pre className="mt-3 max-h-[320px] overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-muted">
                  {file.content}
                </pre>
              </details>
            ))}
          </div>
        </section>
      ) : null}
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
  const [profile, setProfile] = useState<AgentProfileResponse | null>(null);
  const [state, setState] = useState<ProfileState>({ kind: "loading" });
  const [me, setMe] = useState<DevUser | null>(null);
  const [tab, setTab] = useState<
    "creations" | "about" | "concepts" | "skills" | "memory" | "files"
  >("creations");
  const [reloadKey, setReloadKey] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [repairing, setRepairing] = useState(false);
  const [repairNote, setRepairNote] = useState<string | null>(null);
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
  const canManage = isOwner || Boolean(me?.isAdmin);
  const owner = embeddedOwner(agent);
  const displayName = agent.name?.trim() || agent.username;
  const queued = isProvisionQueued(agent.provisionStatus);
  const warming = isProvisionWarming(agent.provisionStatus);
  const failed = isProvisionFailed(agent.provisionStatus);
  // Chat stays available while queued — the first message IS what provisions
  // a dormant migrated agent (lazy provisioning). Only block during an active
  // warm-up or after a failure.
  const chatBlocked = warming || failed;
  const tabs = canManage
    ? (["creations", "about", "concepts", "skills", "memory", "files"] as const)
    : (["creations", "about", "concepts", "skills"] as const);

  const exportAgent = async () => {
    if (exporting) return;
    setExporting(true);
    setExportError(null);
    try {
      const { bundle } = await api.agents.exportBundle(agent.username);
      const text = JSON.stringify(bundle, null, 2);
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${agent.username}-eden3-agent.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setExportError(describeApiFailure(error));
    } finally {
      setExporting(false);
    }
  };

  const repairAgent = async () => {
    if (repairing) return;
    setRepairing(true);
    setRepairNote(null);
    try {
      await api.agents.repair(agent.username);
      setRepairNote("Runtime re-asserted — persona, model, and skills re-synced.");
    } catch (error) {
      setRepairNote(describeApiFailure(error));
    } finally {
      setRepairing(false);
    }
  };

  // Single-user cockpit: only agents you manage have a surface here.
  if (!canManage) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center px-6">
        <EmptyState
          title={`@${agent.username} isn't yours`}
          hint="This cockpit only shows your own agents."
          action={
            <Link href="/agents" className={quietButtonClass}>
              Your agents
            </Link>
          }
          className="w-full max-w-md"
        />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-5xl overflow-x-clip px-3 py-6 sm:px-6 sm:py-10 md:px-10">
      {/* Header */}
      <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
        <AgentAvatar account={agent} size={80} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="min-w-0 break-words text-2xl font-light tracking-tight [overflow-wrap:anywhere] md:text-3xl">
              {displayName}
            </h1>
            {agent.isPilot ? <PilotBadge /> : null}
            <ProvisionBadge status={agent.provisionStatus} />
          </div>
          <p className="mt-1 break-all font-mono text-sm text-faint">@{agent.username}</p>
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
              <>
                <Link
                  href={agentHref(agent.username, "settings")}
                  className={quietButtonClass}
                >
                  Settings
                </Link>
                <Link
                  href={agentHref(agent.username, "gateway")}
                  className={quietButtonClass}
                >
                  Gateway
                </Link>
                <button
                  type="button"
                  onClick={() => void exportAgent()}
                  disabled={exporting}
                  className={quietButtonClass}
                >
                  {exporting ? "Exporting…" : "Export"}
                </button>
              </>
            ) : null}
          </div>
          {isOwner ? (
            <details className="mt-4 max-w-2xl rounded-lg border border-edge/70 bg-raised/30 px-3.5 py-2.5 [&_summary::-webkit-details-marker]:hidden">
              <summary className="cursor-pointer list-none text-xs text-faint transition-colors hover:text-muted">
                Advanced
              </summary>
              <div className="mt-3 space-y-2.5">
                <p className="text-xs leading-relaxed text-faint">
                  Your edits — persona, model, skills — apply to the next message
                  on their own. Restarting only re-asserts the runtime after an
                  infrastructure hiccup: it re-renders workspace files, re-registers
                  the model, and re-syncs skills. Conversations and files are
                  untouched.
                </p>
                <button
                  type="button"
                  onClick={() => void repairAgent()}
                  disabled={repairing}
                  className="rounded-md border border-edge px-3 py-1.5 text-xs text-muted transition-colors hover:border-accent/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {repairing ? "Restarting…" : "Restart runtime"}
                </button>
                {repairNote ? (
                  <p className="rounded-lg border border-edge bg-raised/40 px-3 py-2 text-xs text-muted">
                    {repairNote}
                  </p>
                ) : null}
              </div>
            </details>
          ) : null}
          {exportError ? (
            <p className="mt-3 rounded-lg border border-red-400/25 bg-red-400/5 px-3 py-2 text-xs text-red-400">
              {exportError}
            </p>
          ) : null}
        </div>
      </div>

      {/* Provisioning banner (post-create wait) */}
      {queued ? (
        <div className="mt-8 flex items-center gap-3 rounded-xl border border-accent/25 bg-accent/5 px-4 py-3 text-sm text-muted">
          <span aria-hidden className="size-2 shrink-0 rounded-full bg-accent" />
          This agent is dormant — it wakes up on its first chat. Send a message
          and its runtime sets itself up (the first reply takes a little longer).
        </div>
      ) : warming ? (
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
      <div
        role="tablist"
        aria-label="Agent sections"
        className="mt-8 grid min-w-0 grid-cols-3 gap-1 rounded-xl border border-edge bg-surface p-1 sm:mt-10 sm:flex sm:gap-6 sm:rounded-none sm:border-x-0 sm:border-t-0 sm:bg-transparent sm:p-0"
      >
        {tabs.map((key) => (
          <button
            key={key}
            role="tab"
            type="button"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`min-w-0 rounded-lg border-b-2 px-1 py-2 text-xs capitalize transition-colors sm:-mb-px sm:rounded-none sm:pb-2.5 sm:pt-0 sm:text-sm ${
              tab === key
                ? "border-accent bg-accent/10 text-foreground sm:bg-transparent"
                : "border-transparent text-muted hover:bg-white/[0.03] hover:text-foreground sm:hover:bg-transparent"
            }`}
          >
            {key}
          </button>
        ))}
      </div>

      <div className="mt-5 min-w-0 sm:mt-6">
        {tab === "creations" ? (
          <AgentCreations username={agent.username} seed={recentCreations} />
        ) : tab === "about" ? (
          <AboutSection agent={agent} isOwner={isOwner} />
        ) : tab === "concepts" ? (
          <AgentConceptsPanel
            username={agent.username}
            agentName={displayName}
            canManage={canManage}
          />
        ) : tab === "memory" ? (
          <AgentMemoryPanel username={agent.username} seed={profile.memory} canManage={canManage} />
        ) : tab === "files" ? (
          <AgentWorkspacePanel username={agent.username} canManage={canManage} />
        ) : (
          <AgentSkillsPanel username={agent.username} canManage={canManage} />
        )}
      </div>
    </div>
  );
}
