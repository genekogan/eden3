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
import type { ChangeEvent, FormEvent, ReactNode } from "react";
import { api, ApiError, isEndpointMissing } from "@/lib/api";
import type { AgentDto, AgentUpdateInput } from "@/lib/types";
import { AgentAvatar } from "@/components/agent-avatar";
import {
  conceptImageFileError,
  fileToUpload,
} from "@/components/agents/agent-concepts";
import { EmptyState } from "@/components/empty-state";
import { Skeleton, SkeletonText } from "@/components/skeleton";
import { agentHref } from "@/components/agents/agent-card";
import {
  apiErrorDetail,
  describeApiFailure,
} from "@/components/agents/agent-utils";
import {
  ButtonSpinner,
  FieldShell,
  inputClass,
  primaryButtonClass,
  quietButtonClass,
  TextAreaField,
  TextField,
} from "@/components/agents/form-fields";
import {
  MODEL_TIER_OPTIONS,
  THINKING_LEVEL_OPTIONS,
  TOOL_GROUP_OPTIONS,
  normalizeAgentModel,
  normalizeThinkingLevel,
  normalizeToolGroups,
} from "@/components/agents/runtime-config";
import { Toast } from "@/components/agents/toast";

type Fields = {
  name: string;
  description: string;
  greeting: string;
  voice: string;
  persona: string;
  model: string;
  thinkingLevel: string;
  toolGroups: string[];
  public: boolean;
};
type EditableKey = keyof Fields;

function fieldsOf(agent: AgentDto): Fields {
  return {
    name: agent.name ?? "",
    description: agent.description ?? "",
    greeting: agent.greeting ?? "",
    voice: agent.voice ?? "",
    persona: agent.persona ?? "",
    model: normalizeAgentModel(agent.model),
    thinkingLevel: normalizeThinkingLevel(agent.thinkingLevel),
    toolGroups: normalizeToolGroups(agent.toolGroups),
    public: agent.public !== false,
  };
}

function diff(baseline: Fields, current: Fields): AgentUpdateInput {
  const patch: AgentUpdateInput = {};
  if (current.name !== baseline.name) patch.name = current.name;
  if (current.description !== baseline.description) patch.description = current.description;
  if (current.greeting !== baseline.greeting) patch.greeting = current.greeting;
  if (current.voice !== baseline.voice) patch.voice = current.voice;
  if (current.persona !== baseline.persona) patch.persona = current.persona;
  if (current.model !== baseline.model) patch.model = current.model;
  if (current.thinkingLevel !== baseline.thinkingLevel) patch.thinkingLevel = current.thinkingLevel;
  if (JSON.stringify(current.toolGroups) !== JSON.stringify(baseline.toolGroups)) {
    patch.toolGroups = current.toolGroups;
  }
  if (current.public !== baseline.public) patch.public = current.public;
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
    voice: "",
    persona: "",
    model: normalizeAgentModel(null),
    thinkingLevel: normalizeThinkingLevel(null),
    toolGroups: normalizeToolGroups(null),
    public: true,
  });
  const baseline = useRef<Fields>(fields);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const seq = useRef(0);
  const avatarInput = useRef<HTMLInputElement | null>(null);
  const [avatarBusy, setAvatarBusy] = useState<"upload" | "remove" | null>(null);
  const [avatarNote, setAvatarNote] = useState<string | null>(null);

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

  const setField = (key: Exclude<EditableKey, "toolGroups">) => (value: string) => {
    setFields((prev) => ({ ...prev, [key]: value }));
  };

  const setToolGroup = (value: string, enabled: boolean) => {
    setFields((prev) => {
      const next = new Set(prev.toolGroups);
      if (enabled) next.add(value);
      else next.delete(value);
      return { ...prev, toolGroups: TOOL_GROUP_OPTIONS.map((option) => option.value).filter((v) => next.has(v)) };
    });
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
      setToast("Live — updates apply to the next message");
    } catch (error) {
      setSaveError(apiErrorDetail(error));
    } finally {
      setSaving(false);
    }
  };

  // Avatar changes are their own action (immediate, not part of the dirty
  // persona diff): update local agent.userImage so the preview refreshes.
  const applyAvatarUpdate = (updated: AgentDto) => {
    setGate((prev) =>
      prev.kind === "ready"
        ? { kind: "ready", agent: { ...prev.agent, ...updated } }
        : prev,
    );
  };

  const onAvatarPicked = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!file || gate.kind !== "ready" || avatarBusy) return;
    const problem = conceptImageFileError(file);
    if (problem) {
      setAvatarNote(problem);
      return;
    }
    setAvatarBusy("upload");
    setAvatarNote(null);
    try {
      applyAvatarUpdate(
        await api.agents.uploadAvatar(gate.agent.username, await fileToUpload(file)),
      );
    } catch (error) {
      setAvatarNote(apiErrorDetail(error));
    } finally {
      setAvatarBusy(null);
    }
  };

  const removeAvatar = async () => {
    if (gate.kind !== "ready" || avatarBusy) return;
    setAvatarBusy("remove");
    setAvatarNote(null);
    try {
      applyAvatarUpdate(await api.agents.removeAvatar(gate.agent.username));
    } catch (error) {
      setAvatarNote(apiErrorDetail(error));
    } finally {
      setAvatarBusy(null);
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
        <div className="min-w-0">
          <h1 className="text-2xl font-light tracking-tight md:text-3xl">
            Edit {agent.name?.trim() || `@${agent.username}`}
          </h1>
          <p className="mt-0.5 font-mono text-xs text-faint">
            @{agent.username}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          ref={avatarInput}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={(event) => void onAvatarPicked(event)}
          className="hidden"
        />
        <button
          type="button"
          onClick={() => avatarInput.current?.click()}
          disabled={avatarBusy !== null || saving}
          className={quietButtonClass}
        >
          {avatarBusy === "upload" ? "Uploading…" : "Change photo"}
        </button>
        {agent.userImage ? (
          <button
            type="button"
            onClick={() => void removeAvatar()}
            disabled={avatarBusy !== null || saving}
            className={quietButtonClass}
          >
            {avatarBusy === "remove" ? "Removing…" : "Remove"}
          </button>
        ) : null}
        {avatarNote ? (
          <p className="text-xs text-rose-300">{avatarNote}</p>
        ) : null}
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

        <TextField
          id="edit-voice"
          label="Voice"
          value={fields.voice}
          onChange={setField("voice")}
          disabled={saving}
          maxLength={200}
          hint="Tone note or external voice id."
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

        <label className="flex items-start gap-3 rounded-lg border border-edge bg-raised/40 p-4">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 accent-accent"
            checked={fields.public}
            disabled={saving}
            onChange={(event) =>
              setFields((prev) => ({ ...prev, public: event.target.checked }))
            }
          />
          <span className="min-w-0">
            <span className="block text-sm text-foreground">
              Listed publicly
            </span>
            <span className="block text-xs text-faint">
              Public agents appear in the directory and their profile is open to
              everyone. Private agents are visible only to you.
            </span>
          </span>
        </label>

        <details className="rounded-lg border border-edge bg-raised/40 p-4">
          <summary className="cursor-pointer text-sm text-foreground">
            Advanced runtime
          </summary>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <FieldShell
              id="edit-model"
              label="Model tier"
              hint="Changing this updates the OpenClaw model registration."
            >
              <select
                id="edit-model"
                value={fields.model}
                onChange={(event) => setField("model")(event.target.value)}
                disabled={saving}
                className={inputClass}
              >
                {MODEL_TIER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label} · {option.detail}
                  </option>
                ))}
              </select>
            </FieldShell>

            <FieldShell
              id="edit-thinking"
              label="Thinking level"
              hint="Stored with the next chat usage record."
            >
              <select
                id="edit-thinking"
                value={fields.thinkingLevel}
                onChange={(event) => setField("thinkingLevel")(event.target.value)}
                disabled={saving}
                className={inputClass}
              >
                {THINKING_LEVEL_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </FieldShell>

            <FieldShell
              id="edit-skills"
              label="Skills"
              hint="Curated and approved user-authored skills attach from the profile skills tab."
            >
              <Link href={agentHref(agent.username)} className={quietButtonClass}>
                Manage skills
              </Link>
            </FieldShell>
          </div>

          <FieldShell
            id="edit-tool-groups"
            label="Tool groups"
            hint="Per-agent OpenClaw allowlist. Sandbox and elevated controls stay enforced globally."
          >
            <div className="grid gap-2 sm:grid-cols-2">
              {TOOL_GROUP_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className="flex min-h-12 items-start gap-3 rounded-md border border-edge bg-surface/50 px-3 py-2"
                >
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 accent-accent"
                    checked={fields.toolGroups.includes(option.value)}
                    disabled={saving}
                    onChange={(event) => setToolGroup(option.value, event.target.checked)}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm text-foreground">{option.label}</span>
                    <span className="block break-words font-mono text-[11px] text-faint">
                      {option.value} · {option.detail}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </FieldShell>
        </details>

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
