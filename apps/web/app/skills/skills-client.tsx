"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, isEndpointMissing } from "@/lib/api";
import type { DevUser, SkillDefinitionDto, SkillStatus } from "@/lib/types";
import { EmptyState } from "@/components/empty-state";
import { SkeletonRows } from "@/components/skeleton";
import { formatRelativeTime } from "@/lib/format";

type Phase = "loading" | "ready" | "error";

function errorCopy(error: unknown): { title: string; hint: string } {
  if (isEndpointMissing(error)) {
    return {
      title: "Skills aren't wired up yet",
      hint: "GET /api/skills is not available.",
    };
  }
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return { title: "No access", hint: "Pick a dev user in the sidebar." };
    }
    return { title: "Couldn't load skills", hint: error.message };
  }
  return { title: "API offline", hint: "Start @eden3/api on :4301 and retry." };
}

function statusClass(status: SkillStatus): string {
  if (status === "approved") {
    return "border-success/25 bg-success/10 text-success-soft";
  }
  if (status === "rejected") {
    return "border-danger/25 bg-danger/10 text-danger-soft";
  }
  return "border-warning/25 bg-warning/10 text-warning-soft";
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-faint">
        {label}
      </span>
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

function SkillRow({
  skill,
  isAdmin,
  busy,
  onReview,
}: {
  skill: SkillDefinitionDto;
  isAdmin: boolean;
  busy: boolean;
  onReview: (skill: SkillDefinitionDto, status: "approved" | "rejected") => void;
}) {
  const canReview = isAdmin && skill.status === "pending";
  return (
    <article className="rounded-xl border border-edge bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-medium text-foreground">{skill.name}</h2>
            <span className={`rounded-full border px-2 py-0.5 text-[11px] ${statusClass(skill.status)}`}>
              {skill.status}
            </span>
            <span className="rounded-full border border-edge px-2 py-0.5 text-[11px] text-faint">
              {skill.source}
            </span>
          </div>
          <p className="mt-1 font-mono text-xs text-faint">{skill.slug}</p>
        </div>
        {canReview ? (
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => onReview(skill, "approved")}
              className="rounded-lg border border-success/30 px-3 py-1.5 text-xs text-success-soft hover:bg-success/10 disabled:opacity-50"
            >
              Approve
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onReview(skill, "rejected")}
              className="rounded-lg border border-danger/30 px-3 py-1.5 text-xs text-danger-soft hover:bg-danger/10 disabled:opacity-50"
            >
              Reject
            </button>
          </div>
        ) : null}
      </div>
      {skill.description ? (
        <p className="mt-3 text-sm leading-relaxed text-muted">{skill.description}</p>
      ) : null}
      <pre className="mt-3 max-h-40 overflow-auto rounded-lg border border-edge bg-background p-3 font-mono text-[12px] leading-relaxed text-muted">
        {skill.body}
      </pre>
      <p className="mt-3 text-xs text-faint">
        Updated {formatRelativeTime(skill.updatedAt)}
      </p>
    </article>
  );
}

export function SkillsClient() {
  const [skills, setSkills] = useState<SkillDefinitionDto[]>([]);
  const [me, setMe] = useState<DevUser | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [loadError, setLoadError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const alive = useRef(true);

  const load = useCallback(async (soft = false) => {
    if (!soft) setPhase("loading");
    try {
      const [page, user] = await Promise.all([api.skills.list(), api.dev.me()]);
      if (!alive.current) return;
      setSkills(page.items);
      setMe(user);
      setPhase("ready");
      setLoadError(null);
    } catch (error) {
      if (!alive.current) return;
      if (soft) setNote(errorCopy(error).hint);
      else {
        setLoadError(error);
        setPhase("error");
      }
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  useEffect(() => {
    if (!note) return;
    const timer = window.setTimeout(() => setNote(null), 7000);
    return () => window.clearTimeout(timer);
  }, [note]);

  const filtered = useMemo(() => {
    const order: Record<SkillStatus, number> = { pending: 0, approved: 1, rejected: 2 };
    return [...skills].sort((a, b) => {
      const status = order[a.status] - order[b.status];
      return status === 0 ? a.slug.localeCompare(b.slug) : status;
    });
  }, [skills]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy("create");
    setNote(null);
    try {
      const skill = await api.skills.createUser({
        slug,
        name,
        description: description.trim() || undefined,
        body,
      });
      if (!alive.current) return;
      setSkills((prev) => [skill, ...prev.filter((item) => item.id !== skill.id)]);
      setSlug("");
      setName("");
      setDescription("");
      setBody("");
      setNote("Skill submitted.");
    } catch (error) {
      if (alive.current) setNote(errorCopy(error).hint);
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const review = async (skill: SkillDefinitionDto, status: "approved" | "rejected") => {
    setBusy(`review:${skill.slug}`);
    setNote(null);
    try {
      const updated = await api.skills.review(skill.slug, { status });
      if (!alive.current) return;
      setSkills((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    } catch (error) {
      if (alive.current) setNote(errorCopy(error).hint);
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const inputClass =
    "w-full rounded-lg border border-edge bg-background px-3 py-2 text-sm text-foreground placeholder:text-faint focus:border-accent/60 focus:outline-none";

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-14 md:px-10">
      <header>
        <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-faint">
          Runtime
        </p>
        <h1 className="mt-2 text-3xl font-light tracking-tight md:text-4xl">
          Skills
        </h1>
      </header>

      {note ? (
        <p
          role="status"
          className="mt-6 rounded-lg border border-accent/25 bg-accent/10 px-3 py-2 text-xs text-accent-soft"
        >
          {note}
        </p>
      ) : null}

      <div className="mt-10 grid gap-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <form onSubmit={(event) => void submit(event)} className="rounded-xl border border-edge bg-surface p-4">
          <div className="space-y-4">
            <Field label="Slug">
              <input
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
                required
                minLength={2}
                maxLength={64}
                placeholder="visual-critic"
                className={inputClass}
              />
            </Field>
            <Field label="Name">
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={120}
                placeholder="Visual Critic"
                className={inputClass}
              />
            </Field>
            <Field label="Description">
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={2000}
                rows={3}
                className={inputClass}
              />
            </Field>
            <Field label="SKILL.md">
              <textarea
                value={body}
                onChange={(event) => setBody(event.target.value)}
                required
                minLength={20}
                maxLength={50000}
                rows={14}
                className={`${inputClass} font-mono text-[13px] leading-relaxed`}
              />
            </Field>
          </div>
          <button
            type="submit"
            disabled={busy === "create"}
            className="mt-5 w-full rounded-lg border border-accent/40 bg-accent/15 px-4 py-2 text-sm text-accent-soft hover:bg-accent/20 disabled:opacity-50"
          >
            {busy === "create" ? "Submitting…" : "Submit"}
          </button>
        </form>

        <section>
          {phase === "loading" ? (
            <SkeletonRows count={6} />
          ) : phase === "error" ? (
            <EmptyState
              title={errorCopy(loadError).title}
              hint={errorCopy(loadError).hint}
              action={
                <button
                  type="button"
                  onClick={() => void load()}
                  className="rounded-lg border border-edge px-3 py-2 text-sm text-muted hover:text-foreground"
                >
                  Retry
                </button>
              }
            />
          ) : filtered.length === 0 ? (
            <EmptyState title="No skills" hint="Approved skills will appear here." />
          ) : (
            <div className="space-y-3">
              {filtered.map((skill) => (
                <SkillRow
                  key={skill.id}
                  skill={skill}
                  isAdmin={Boolean(me?.isAdmin)}
                  busy={busy === `review:${skill.slug}`}
                  onReview={(item, status) => void review(item, status)}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
