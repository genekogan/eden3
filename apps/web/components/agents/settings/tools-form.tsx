"use client";

/**
 * Settings › Tools — which tool groups the agent may use, with the raw
 * runtime knobs (model tier, thinking level) behind an Advanced disclosure
 * (SPEC Q3: friendly defaults up front, power underneath).
 */

import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { AgentDto, AgentUpdateInput } from "@/lib/types";
import {
  ButtonSpinner,
  FieldShell,
  inputClass,
  primaryButtonClass,
  quietButtonClass,
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
import { Skeleton } from "@/components/skeleton";
import { useSelectedAgent } from "@/components/shell/selected-agent-context";
import { useAgentPatch } from "./use-agent-patch";
import { useSettingsUnsavedChanges } from "./unsaved-changes";

type Fields = { model: string; thinkingLevel: string; toolGroups: string[] };

const fieldsOf = (agent: AgentDto): Fields => ({
  model: normalizeAgentModel(agent.model),
  thinkingLevel: normalizeThinkingLevel(agent.thinkingLevel),
  toolGroups: normalizeToolGroups(agent.toolGroups),
});

export function ToolsForm({ username }: { username: string }) {
  const { agent } = useSelectedAgent();
  const { saving, saveError, toast, setToast, save } = useAgentPatch(username);
  const [fields, setFields] = useState<Fields | null>(null);
  const baseline = useRef<Fields | null>(null);
  const initializedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!agent || initializedFor.current === agent.username) return;
    initializedFor.current = agent.username;
    const initial = fieldsOf(agent);
    baseline.current = initial;
    setFields(initial);
  }, [agent]);

  const setToolGroup = (value: string, enabled: boolean) => {
    setFields((prev) => {
      if (!prev) return prev;
      const next = new Set(prev.toolGroups);
      if (enabled) next.add(value);
      else next.delete(value);
      return {
        ...prev,
        toolGroups: TOOL_GROUP_OPTIONS.map((o) => o.value).filter((v) => next.has(v)),
      };
    });
  };

  const dirty =
    fields !== null && baseline.current !== null &&
    JSON.stringify(fields) !== JSON.stringify(baseline.current);

  const saveChanges = async (): Promise<boolean> => {
    if (saving || !fields || !baseline.current) return false;
    const snapshot: Fields = { ...fields, toolGroups: [...fields.toolGroups] };
    const patch: AgentUpdateInput = {};
    if (snapshot.model !== baseline.current.model) patch.model = snapshot.model;
    if (snapshot.thinkingLevel !== baseline.current.thinkingLevel) {
      patch.thinkingLevel = snapshot.thinkingLevel;
    }
    if (JSON.stringify(snapshot.toolGroups) !== JSON.stringify(baseline.current.toolGroups)) {
      patch.toolGroups = snapshot.toolGroups;
    }
    if (await save(patch, "Saved — runtime updates apply to the next message.")) {
      baseline.current = snapshot;
      return true;
    }
    return false;
  };

  const discardChanges = () => {
    if (baseline.current) {
      setFields({ ...baseline.current, toolGroups: [...baseline.current.toolGroups] });
    }
  };

  useSettingsUnsavedChanges({
    label: "this agent’s tools and runtime",
    dirty,
    saving,
    save: saveChanges,
    discard: discardChanges,
  });

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    await saveChanges();
  };

  if (!agent || !fields) {
    return (
      <div className="space-y-4" aria-busy>
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="space-y-6">
      <FieldShell
        id="tools-groups"
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

      <details className="rounded-lg border border-edge bg-raised/40 p-4">
        <summary className="cursor-pointer text-sm text-foreground">Advanced runtime</summary>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <FieldShell
            id="tools-model"
            label="Model tier"
            hint="Changing this updates the OpenClaw model registration."
          >
            <select
              id="tools-model"
              value={fields.model}
              onChange={(event) =>
                setFields((prev) => (prev ? { ...prev, model: event.target.value } : prev))
              }
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
            id="tools-thinking"
            label="Thinking level"
            hint="Stored with the next chat usage record."
          >
            <select
              id="tools-thinking"
              value={fields.thinkingLevel}
              onChange={(event) =>
                setFields((prev) =>
                  prev ? { ...prev, thinkingLevel: event.target.value } : prev,
                )
              }
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
        </div>
      </details>

      {saveError ? (
        <p className="rounded-lg border border-danger/25 bg-danger/5 px-3 py-2 text-xs text-danger">
          {saveError}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2.5 border-t border-edge pt-5">
        <p role="status" className="text-xs text-faint">
          {saving ? "Saving…" : dirty ? "Unsaved changes" : "All changes saved"}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={discardChanges}
            disabled={saving || !dirty}
            className={quietButtonClass}
          >
            Discard changes
          </button>
          <button type="submit" disabled={saving || !dirty} className={primaryButtonClass}>
            {saving ? <ButtonSpinner /> : null}
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>

      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}
    </form>
  );
}
