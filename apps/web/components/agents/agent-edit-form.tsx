"use client";

/**
 * /agents/[username]/edit — owner-only editor for name / description /
 * greeting / persona. PATCH /api/agents/:username sends just the dirty
 * fields; persona is hot (no restart), so the success toast says exactly
 * that: "Live — persona updates apply to the next message".
 *
 * Ownership = the impersonated dev user (GET /api/dev/me) matches
 * agent.ownerId. Anyone else gets a quiet gate, not a form.
 */

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { api, ApiError, isEndpointMissing } from "@/lib/api";
import type { AgentDto, AgentUpdateInput } from "@/lib/types";
import { AgentAvatar } from "@/components/agent-avatar";
import { EmptyState } from "@/components/empty-state";
import { Skeleton, SkeletonText } from "@/components/skeleton";
import { agentHref } from "@/components/agents/agent-card";
import {
  apiErrorDetail,
  describeApiFailure,
} from "@/components/agents/agent-utils";
import {
  ButtonSpinner,
  primaryButtonClass,
  quietButtonClass,
  TextAreaField,
  TextField,
} from "@/components/agents/form-fields";
import { Toast } from "@/components/agents/toast";

type EditableKey = "name" | "description" | "greeting" | "persona";
type Fields = Record<EditableKey, string>;

function fieldsOf(agent: AgentDto): Fields {
  return {
    name: agent.name ?? "",
    description: agent.description ?? "",
    greeting: agent.greeting ?? "",
    persona: agent.persona ?? "",
  };
}

function diff(baseline: Fields, current: Fields): AgentUpdateInput {
  const patch: AgentUpdateInput = {};
  for (const key of Object.keys(current) as EditableKey[]) {
    if (current[key] !== baseline[key]) patch[key] = current[key];
  }
  return patch;
}

type GateState =
  | { kind: "loading" }
  | { kind: "not-found" }
  | { kind: "error"; endpointMissing: boolean; text: string }
  | { kind: "no-user" }
  | { kind: "not-owner"; agent: AgentDto }
  | { kind: "ready"; agent: AgentDto };

function FormSkeleton() {
  return (
    <div aria-hidden className="mt-8 space-y-6 rounded-xl border border-edge bg-surface p-6">
      <Skeleton className="h-9 w-full" />
      <SkeletonText lines={2} />
      <Skeleton className="h-40 w-full" />
      <div className="flex justify-end">
        <Skeleton className="h-9 w-32 rounded-lg" />
      </div>
    </div>
  );
}

export function AgentEditForm({ username }: { username: string }) {
  const [gate, setGate] = useState<GateState>({ kind: "loading" });
  const [fields, setFields] = useState<Fields>({
    name: "",
    description: "",
    greeting: "",
    persona: "",
  });
  const baseline = useRef<Fields>(fields);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const id = ++seq.current;
    setGate({ kind: "loading" });
    void (async () => {
      let agent: AgentDto;
      try {
        ({ agent } = await api.agents.get(username));
      } catch (error) {
        if (seq.current !== id) return;
        setGate(
          error instanceof ApiError && error.status === 404
            ? { kind: "not-found" }
            : {
                kind: "error",
                endpointMissing: isEndpointMissing(error),
                text: describeApiFailure(error),
              },
        );
        return;
      }

      let meId: string | null = null;
      try {
        meId = (await api.dev.me())?.id ?? null;
      } catch {
        meId = null;
      }
      if (seq.current !== id) return;

      if (meId === null) {
        setGate({ kind: "no-user" });
        return;
      }
      if (agent.ownerId === null || agent.ownerId !== meId) {
        setGate({ kind: "not-owner", agent });
        return;
      }
      const initial = fieldsOf(agent);
      baseline.current = initial;
      setFields(initial);
      setGate({ kind: "ready", agent });
    })();
  }, [username, reloadKey]);

  const setField = (key: EditableKey) => (value: string) => {
    setFields((prev) => ({ ...prev, [key]: value }));
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (gate.kind !== "ready" || saving) return;
    setSaveError(null);

    const patch = diff(baseline.current, fields);
    if (Object.keys(patch).length === 0) {
      setToast("Nothing to save — no changes.");
      return;
    }

    setSaving(true);
    try {
      const updated = await api.agents.update(gate.agent.username, patch);
      const merged: AgentDto = { ...gate.agent, ...updated };
      baseline.current = fieldsOf(merged);
      setFields(baseline.current);
      setGate({ kind: "ready", agent: merged });
      setToast("Live — persona updates apply to the next message");
    } catch (error) {
      setSaveError(apiErrorDetail(error));
    } finally {
      setSaving(false);
    }
  };

  const dirty =
    gate.kind === "ready" &&
    Object.keys(diff(baseline.current, fields)).length > 0;

  const shell = (body: ReactNode) => (
    <div className="mx-auto w-full max-w-2xl px-6 py-10 md:px-10">
      <Link
        href={agentHref(username)}
        className="font-mono text-xs text-faint transition-colors hover:text-muted"
      >
        ← @{username}
      </Link>
      {body}
      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}
    </div>
  );

  if (gate.kind === "loading") {
    return shell(
      <>
        <Skeleton className="mt-4 h-9 w-56" />
        <FormSkeleton />
      </>,
    );
  }

  if (gate.kind === "not-found") {
    return shell(
      <EmptyState
        className="mt-8"
        title={`No agent named @${username}`}
        action={
          <Link href="/agents" className={quietButtonClass}>
            Browse agents
          </Link>
        }
      />,
    );
  }

  if (gate.kind === "error") {
    return shell(
      <EmptyState
        className="mt-8"
        title={
          gate.endpointMissing
            ? "Agent profiles aren't wired up yet"
            : `Couldn't load @${username}`
        }
        hint={gate.text}
        action={
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            className={quietButtonClass}
          >
            Try again
          </button>
        }
      />,
    );
  }

  if (gate.kind === "no-user") {
    return shell(
      <EmptyState
        className="mt-8"
        title="Pick a dev user first"
        hint="Editing is owner-only. Impersonate an account from the switcher in the bottom-left, then come back."
      />,
    );
  }

  if (gate.kind === "not-owner") {
    return shell(
      <EmptyState
        className="mt-8"
        title={`You don't own @${username}`}
        hint="Only the agent's owner can edit its persona and profile."
        action={
          <Link href={agentHref(username)} className={quietButtonClass}>
            View profile
          </Link>
        }
      />,
    );
  }

  const { agent } = gate;

  return shell(
    <>
      <div className="mt-4 flex items-center gap-4">
        <AgentAvatar account={agent} size={48} />
        <div>
          <h1 className="text-2xl font-light tracking-tight md:text-3xl">
            Edit {agent.name?.trim() || `@${agent.username}`}
          </h1>
          <p className="mt-0.5 font-mono text-xs text-faint">
            @{agent.username}
          </p>
        </div>
      </div>
      <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted">
        Changes are hot — the persona you save here shapes the very next
        message, no restart.
      </p>

      <form
        onSubmit={(e) => void onSubmit(e)}
        className="mt-8 space-y-6 rounded-xl border border-edge bg-surface p-6"
      >
        <TextField
          id="edit-name"
          label="Name"
          value={fields.name}
          onChange={setField("name")}
          disabled={saving}
          maxLength={80}
        />

        <TextAreaField
          id="edit-description"
          label="Description"
          value={fields.description}
          onChange={setField("description")}
          rows={3}
          disabled={saving}
          hint="Public — shows on the card and profile."
        />

        <TextAreaField
          id="edit-greeting"
          label="Greeting"
          value={fields.greeting}
          onChange={setField("greeting")}
          rows={2}
          disabled={saving}
          hint="The agent's opening line in a fresh chat."
        />

        <TextAreaField
          id="edit-persona"
          label="Persona"
          value={fields.persona}
          onChange={setField("persona")}
          rows={14}
          mono
          disabled={saving}
          hint="The system prompt — voice, temperament, obsessions, boundaries."
        />

        {saveError ? (
          <p className="rounded-lg border border-red-400/25 bg-red-400/5 px-3 py-2 text-xs text-red-400">
            {saveError}
          </p>
        ) : null}

        <div className="flex items-center justify-between gap-2.5 border-t border-edge pt-5">
          <p className="text-xs text-faint">
            {dirty ? "Unsaved changes" : "All changes saved"}
          </p>
          <div className="flex items-center gap-2.5">
            <Link href={agentHref(agent.username)} className={quietButtonClass}>
              View profile
            </Link>
            <button
              type="submit"
              disabled={saving || !dirty}
              className={primaryButtonClass}
            >
              {saving ? <ButtonSpinner /> : null}
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>
      </form>
    </>,
  );
}
