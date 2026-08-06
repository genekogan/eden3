"use client";

/**
 * Settings › Identity — the agent's public face: avatar, name, description,
 * greeting, voice. (Persona lives in its own section; runtime knobs in
 * Tools.) PATCHes only dirty fields; avatar changes apply immediately.
 */

import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { api } from "@/lib/api";
import type { AgentDto } from "@/lib/types";
import { AgentAvatar } from "@/components/agent-avatar";
import { conceptImageFileError, fileToUpload } from "@/components/agents/agent-concepts";
import { apiErrorDetail } from "@/components/agents/agent-utils";
import {
  ButtonSpinner,
  primaryButtonClass,
  quietButtonClass,
  TextAreaField,
  TextField,
} from "@/components/agents/form-fields";
import { Toast } from "@/components/agents/toast";
import { Skeleton } from "@/components/skeleton";
import { useSelectedAgent } from "@/components/shell/selected-agent-context";
import { useAgentPatch } from "./use-agent-patch";

type Fields = { name: string; description: string; greeting: string; voice: string };

const fieldsOf = (agent: AgentDto): Fields => ({
  name: agent.name ?? "",
  description: agent.description ?? "",
  greeting: agent.greeting ?? "",
  voice: agent.voice ?? "",
});

export function IdentityForm({ username }: { username: string }) {
  const { agent, refresh } = useSelectedAgent();
  const { saving, saveError, toast, setToast, save } = useAgentPatch(username);
  const [fields, setFields] = useState<Fields | null>(null);
  const baseline = useRef<Fields | null>(null);
  const [avatarBusy, setAvatarBusy] = useState<"upload" | "remove" | null>(null);
  const [avatarNote, setAvatarNote] = useState<string | null>(null);
  const avatarInput = useRef<HTMLInputElement | null>(null);
  const initializedFor = useRef<string | null>(null);

  // Initialize once per agent; never clobber in-progress edits on refresh.
  useEffect(() => {
    if (!agent || initializedFor.current === agent.username) return;
    initializedFor.current = agent.username;
    const initial = fieldsOf(agent);
    baseline.current = initial;
    setFields(initial);
  }, [agent]);

  if (!agent || !fields) {
    return (
      <div className="space-y-4" aria-busy>
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-9 w-1/2" />
      </div>
    );
  }

  const setField = (key: keyof Fields) => (value: string) =>
    setFields((prev) => (prev ? { ...prev, [key]: value } : prev));

  const dirty =
    baseline.current !== null &&
    JSON.stringify(fields) !== JSON.stringify(baseline.current);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || !baseline.current) return;
    const patch: Record<string, string> = {};
    for (const key of Object.keys(fields) as (keyof Fields)[]) {
      if (fields[key] !== baseline.current[key]) patch[key] = fields[key];
    }
    if (await save(patch, "Saved — identity updates apply to the next message.")) {
      baseline.current = fields;
    }
  };

  const onAvatarPicked = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!file || avatarBusy) return;
    const problem = conceptImageFileError(file);
    if (problem) {
      setAvatarNote(problem);
      return;
    }
    setAvatarBusy("upload");
    setAvatarNote(null);
    try {
      await api.agents.uploadAvatar(username, await fileToUpload(file));
      refresh();
    } catch (error) {
      setAvatarNote(apiErrorDetail(error));
    } finally {
      setAvatarBusy(null);
    }
  };

  const removeAvatar = async () => {
    if (avatarBusy) return;
    setAvatarBusy("remove");
    setAvatarNote(null);
    try {
      await api.agents.removeAvatar(username);
      refresh();
    } catch (error) {
      setAvatarNote(apiErrorDetail(error));
    } finally {
      setAvatarBusy(null);
    }
  };

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="space-y-6">
      <div className="flex items-center gap-4 rounded-xl border border-edge bg-surface p-4">
        <AgentAvatar account={agent} size={56} />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-foreground">Avatar</p>
          <p className="text-xs text-faint">PNG, JPEG, or WEBP.</p>
          {avatarNote ? <p className="mt-1 text-xs text-danger-soft">{avatarNote}</p> : null}
        </div>
        <input
          ref={avatarInput}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={(event) => void onAvatarPicked(event)}
          className="hidden"
        />
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => avatarInput.current?.click()}
            disabled={avatarBusy !== null || saving}
            className={quietButtonClass}
          >
            {avatarBusy === "upload" ? "Uploading…" : "Change"}
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
        </div>
      </div>

      <TextField
        id="identity-name"
        label="Name"
        value={fields.name}
        onChange={setField("name")}
        disabled={saving}
        maxLength={80}
      />

      <TextAreaField
        id="identity-description"
        label="Description"
        value={fields.description}
        onChange={setField("description")}
        rows={3}
        disabled={saving}
        hint="A sentence on what this agent is for."
      />

      <TextAreaField
        id="identity-greeting"
        label="Greeting"
        value={fields.greeting}
        onChange={setField("greeting")}
        rows={2}
        disabled={saving}
        hint="The agent's opening line in a fresh chat."
      />

      <TextField
        id="identity-voice"
        label="Voice"
        value={fields.voice}
        onChange={setField("voice")}
        disabled={saving}
        maxLength={200}
        hint="Tone note or external voice id."
      />

      {saveError ? (
        <p className="rounded-lg border border-danger/25 bg-danger/5 px-3 py-2 text-xs text-danger">
          {saveError}
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-2.5 border-t border-edge pt-5">
        <p className="text-xs text-faint">{dirty ? "Unsaved changes" : "All changes saved"}</p>
        <button type="submit" disabled={saving || !dirty} className={primaryButtonClass}>
          {saving ? <ButtonSpinner /> : null}
          {saving ? "Saving…" : "Save changes"}
        </button>
      </div>

      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}
    </form>
  );
}
