"use client";

/**
 * /agents/new — create an agent.
 *
 * Username availability is probed on blur via GET /api/agents/:username
 * (200 = taken, 404 = free; 501/offline = inconclusive and never blocking).
 * POST /api/agents, then redirect to the new profile, whose provisioning
 * badge polls until the runtime reports ready.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { api } from "@/lib/api";
import type { AgentExportBundle } from "@/lib/types";
import { AgentAvatar } from "@/components/agent-avatar";
import {
  conceptImageFileError,
  fileToUpload,
} from "@/components/agents/agent-concepts";
import {
  apiErrorDetail,
  availabilityFromProbe,
  normalizeUsername,
  usernameError,
  type UsernameAvailability,
} from "@/components/agents/agent-utils";
import { agentHref } from "@/components/agents/agent-card";
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

interface UsernameState {
  availability: UsernameAvailability;
  /** Validation error (format/reserved) — blocks submit. */
  error: string | null;
  /** The value the availability verdict applies to. */
  checked: string;
}

const IDLE: UsernameState = { availability: "idle", error: null, checked: "" };

export const AGENT_TEMPLATES = [
  {
    id: "studio-companion",
    label: "Studio companion",
    username: "studio-companion",
    name: "Studio Companion",
    description: "A practical creative partner for image, video, and sound work.",
    greeting: "What are we making today?",
    persona:
      "You are Studio Companion, a concise creative collaborator. Ask only the clarifying questions that improve the result, then help the user make images, videos, audio, and remix plans with clear taste and practical constraints.",
  },
  {
    id: "research-scout",
    label: "Research scout",
    username: "research-scout",
    name: "Research Scout",
    description: "A careful researcher that turns messy questions into sourced briefs.",
    greeting: "Send me the question and the bar for evidence.",
    persona:
      "You are Research Scout, a rigorous research assistant. Separate facts from inference, cite primary sources when possible, keep uncertainty visible, and produce short briefs that can be acted on.",
  },
  {
    id: "daily-practice",
    label: "Daily practice",
    username: "daily-practice",
    name: "Daily Practice",
    description: "A scheduled creative ritual agent for recurring prompts and posts.",
    greeting: "Let's define the practice.",
    persona:
      "You are Daily Practice, a steady creative partner. Help the user design repeatable daily prompts, keep outputs varied, and turn small constraints into a durable body of work.",
  },
] as const;

function UsernameNote({ state }: { state: UsernameState }) {
  if (state.error) return <p className="text-danger">{state.error}</p>;
  switch (state.availability) {
    case "checking":
      return <p className="text-faint">Checking @{state.checked}…</p>;
    case "available":
      return <p className="text-success/90">@{state.checked} is available</p>;
    case "taken":
      return <p className="text-danger">@{state.checked} is taken</p>;
    case "unknown":
      return (
        <p className="text-faint">
          Couldn't verify availability — you can still try creating.
        </p>
      );
    default:
      return null;
  }
}

export function AgentCreateForm() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [greeting, setGreeting] = useState("");
  const [voice, setVoice] = useState("");
  const [persona, setPersona] = useState("");
  const [model, setModel] = useState(normalizeAgentModel(null));
  const [thinkingLevel, setThinkingLevel] = useState(normalizeThinkingLevel(null));
  const [toolGroups, setToolGroups] = useState<string[]>(normalizeToolGroups(null));
  const [importBundle, setImportBundle] = useState<AgentExportBundle | null>(null);
  const [importName, setImportName] = useState<string | null>(null);
  const [usernameState, setUsernameState] = useState<UsernameState>(IDLE);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const probeSeq = useRef(0);

  // Revoke the previous object URL whenever the preview changes / unmounts.
  useEffect(() => {
    if (!avatarPreview) return;
    return () => URL.revokeObjectURL(avatarPreview);
  }, [avatarPreview]);

  const pickAvatar = (file: File | null) => {
    if (!file) return;
    const problem = conceptImageFileError(file);
    if (problem) {
      setFormError(problem);
      return;
    }
    setFormError(null);
    setAvatarFile(file);
    setAvatarPreview(URL.createObjectURL(file));
  };

  const clearAvatar = () => {
    setAvatarFile(null);
    setAvatarPreview(null);
  };

  const checkAvailability = async () => {
    const candidate = normalizeUsername(username);
    if (!candidate) {
      setUsernameState(IDLE);
      return;
    }
    const error = usernameError(candidate);
    if (error) {
      setUsernameState({ availability: "idle", error, checked: candidate });
      return;
    }
    const id = ++probeSeq.current;
    setUsernameState({ availability: "checking", error: null, checked: candidate });
    let probeError: unknown | null = null;
    try {
      await api.agents.get(candidate);
    } catch (caught) {
      probeError = caught;
    }
    if (probeSeq.current !== id) return;
    setUsernameState({
      availability: availabilityFromProbe(probeError),
      error: null,
      checked: candidate,
    });
  };

  const applyTemplate = (template: (typeof AGENT_TEMPLATES)[number]) => {
    setImportBundle(null);
    setImportName(null);
    // Clicking an archetype card is an explicit "load this template" intent, so
    // every field is overwritten unconditionally — otherwise the first template
    // fills the empty fields and every later click no-ops.
    setUsername(template.username);
    setName(template.name);
    setDescription(template.description);
    setGreeting(template.greeting);
    setVoice("");
    setPersona(template.persona);
    setModel(normalizeAgentModel(null));
    setThinkingLevel(normalizeThinkingLevel(null));
    setToolGroups(normalizeToolGroups(null));
    setUsernameState(IDLE);
  };

  const loadBundle = async (file: File | null) => {
    if (!file) return;
    setFormError(null);
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const candidate =
        parsed && typeof parsed === "object" && "bundle" in parsed
          ? (parsed as { bundle: unknown }).bundle
          : parsed;
      if (
        !candidate ||
        typeof candidate !== "object" ||
        (candidate as { kind?: unknown }).kind !== "eden3.agent.bundle" ||
        (candidate as { version?: unknown }).version !== 1 ||
        !((candidate as { agent?: unknown }).agent instanceof Object)
      ) {
        throw new Error("Invalid Eden3 agent bundle.");
      }
      const bundle = candidate as AgentExportBundle;
      const sourceUsername =
        typeof bundle.agent.username === "string" ? bundle.agent.username : "";
      const base =
        normalizeUsername(sourceUsername || bundle.agent.name || "agent")
          .slice(0, 24)
          .replace(/[-_]+$/, "") || "agent";
      setImportBundle(bundle);
      setImportName(file.name);
      setUsername(`${base}-copy`.slice(0, 32));
      setName(bundle.agent.name ?? "");
      setDescription(bundle.agent.description ?? "");
      setGreeting(bundle.agent.greeting ?? "");
      setVoice(bundle.agent.voice ?? "");
      setPersona(bundle.agent.persona ?? "");
      setModel(normalizeAgentModel(bundle.agent.model));
      setThinkingLevel(normalizeThinkingLevel(bundle.agent.thinkingLevel));
      setToolGroups(normalizeToolGroups(bundle.agent.toolGroups));
      setUsernameState(IDLE);
    } catch (error) {
      setImportBundle(null);
      setImportName(null);
      setFormError(error instanceof Error ? error.message : "Invalid bundle.");
    }
  };

  const clearBundle = () => {
    setImportBundle(null);
    setImportName(null);
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setFormError(null);

    const candidate = normalizeUsername(username);
    const invalid = usernameError(candidate);
    if (invalid) {
      setUsernameState({ availability: "idle", error: invalid, checked: candidate });
      return;
    }
    if (
      usernameState.availability === "taken" &&
      usernameState.checked === candidate
    ) {
      return; // the note already says it's taken
    }
    if (!name.trim()) {
      setFormError("Give the agent a display name.");
      return;
    }

    setSubmitting(true);
    try {
      const agent = importBundle
        ? (
            await api.agents.importBundle({
              username: candidate,
              name: name.trim(),
              bundle: {
                ...importBundle,
                agent: {
                  ...importBundle.agent,
                  username: candidate,
                  name: name.trim(),
                  description: description.trim(),
                  persona: persona.trim(),
                  greeting: greeting.trim(),
                  voice: voice.trim(),
                  model,
                  thinkingLevel,
                  toolGroups,
                },
              },
            })
          ).agent
        : await api.agents.create({
            username: candidate,
            name: name.trim(),
            description: description.trim(),
            persona: persona.trim(),
            greeting: greeting.trim(),
            voice: voice.trim(),
            model,
            thinkingLevel,
            toolGroups,
          });
      const created = agent.username ?? candidate;
      // Create-then-upload: the agent exists now, so an avatar failure is
      // non-fatal — the owner can set one from the edit page rather than being
      // stranded on a form for an agent that was already created.
      if (avatarFile) {
        try {
          await api.agents.uploadAvatar(created, await fileToUpload(avatarFile));
        } catch {
          /* best-effort; agent is created regardless */
        }
      }
      router.push(agentHref(created));
    } catch (error) {
      setFormError(apiErrorDetail(error));
      setSubmitting(false);
    }
  };

  const submitBlocked =
    submitting ||
    (usernameState.availability === "taken" &&
      usernameState.checked === normalizeUsername(username)) ||
    Boolean(usernameState.error && usernameState.checked === normalizeUsername(username));

  const setToolGroup = (value: string, enabled: boolean) => {
    setToolGroups((prev) => {
      const next = new Set(prev);
      if (enabled) next.add(value);
      else next.delete(value);
      return TOOL_GROUP_OPTIONS.map((option) => option.value).filter((v) => next.has(v));
    });
  };

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-10 md:px-10">
      <Link
        href="/agents"
        className="font-mono text-xs text-faint transition-colors hover:text-muted"
      >
        ← Agents
      </Link>
      <h1 className="mt-4 text-3xl font-light tracking-tight md:text-4xl">
        Create agent
      </h1>
      <p className="mt-2 max-w-lg text-sm leading-relaxed text-muted">
        Name it, give it a persona, and it goes live once its runtime is
        provisioned. Persona edits later are hot — they apply to the next
        message.
      </p>

      <div className="mt-8 grid gap-3 sm:grid-cols-3">
        {AGENT_TEMPLATES.map((template) => (
          <button
            key={template.id}
            type="button"
            onClick={() => applyTemplate(template)}
            className="rounded-xl border border-edge bg-surface p-4 text-left transition-colors hover:border-accent/50 hover:bg-accent/[0.04]"
          >
            <span className="block text-sm font-medium text-foreground">
              {template.label}
            </span>
            <span className="mt-1.5 line-clamp-2 block text-xs leading-relaxed text-muted">
              {template.description}
            </span>
          </button>
        ))}
      </div>

      <div className="mt-5 rounded-xl border border-edge bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-faint">
              Import bundle
            </p>
            {importBundle ? (
              <p className="mt-1 text-sm text-muted">
                {importName ?? "Loaded bundle"} · {importBundle.skills.length} skills ·{" "}
                {importBundle.memory.items.length} memory items
              </p>
            ) : null}
          </div>
          {importBundle ? (
            <button
              type="button"
              onClick={clearBundle}
              className={quietButtonClass}
            >
              Clear
            </button>
          ) : (
            <label className={quietButtonClass}>
              Load JSON
              <input
                type="file"
                accept="application/json,.json"
                className="sr-only"
                onChange={(event) => void loadBundle(event.target.files?.[0] ?? null)}
              />
            </label>
          )}
        </div>
      </div>

      <form
        onSubmit={(e) => void onSubmit(e)}
        className="mt-8 space-y-6 rounded-xl border border-edge bg-surface p-6"
      >
        <FieldShell
          id="agent-avatar"
          label="Avatar"
          optional
          hint="PNG, JPEG, or WebP up to 8MB — uploaded once the agent is created. You can change it later."
        >
          <div className="flex items-center gap-4">
            <AgentAvatar src={avatarPreview} name={name || username || "?"} size={56} />
            <div className="flex flex-wrap items-center gap-2">
              <label className={quietButtonClass}>
                {avatarFile ? "Change photo" : "Add photo"}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="sr-only"
                  disabled={submitting}
                  onChange={(event) => pickAvatar(event.target.files?.[0] ?? null)}
                />
              </label>
              {avatarFile ? (
                <button
                  type="button"
                  onClick={clearAvatar}
                  disabled={submitting}
                  className={quietButtonClass}
                >
                  Remove
                </button>
              ) : null}
            </div>
          </div>
        </FieldShell>

        <FieldShell
          id="agent-username"
          label="Username"
          hint="Lowercase letters, numbers, - and _. This is the permanent @handle."
          note={<UsernameNote state={usernameState} />}
        >
          <div className="relative">
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 left-3 flex items-center font-mono text-sm text-faint"
            >
              @
            </span>
            <input
              id="agent-username"
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                setUsernameState(IDLE);
              }}
              onBlur={() => void checkAvailability()}
              placeholder="verdelis"
              autoFocus
              disabled={submitting}
              maxLength={40}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className={`${inputClass} pl-8 font-mono lowercase`}
            />
          </div>
        </FieldShell>

        <TextField
          id="agent-name"
          label="Name"
          value={name}
          onChange={setName}
          placeholder="Verdelis"
          hint="Display name shown everywhere."
          disabled={submitting}
          maxLength={80}
        />

        <TextAreaField
          id="agent-description"
          label="Description"
          value={description}
          onChange={setDescription}
          rows={3}
          optional
          placeholder="A gardener of imaginary ecosystems…"
          hint="One or two public sentences — shows on the card and profile."
          disabled={submitting}
        />

        <TextAreaField
          id="agent-greeting"
          label="Greeting"
          value={greeting}
          onChange={setGreeting}
          rows={2}
          optional
          placeholder="Hi — want to grow something strange together?"
          hint="The agent's opening line in a fresh chat."
          disabled={submitting}
        />

        <TextField
          id="agent-voice"
          label="Voice"
          value={voice}
          onChange={setVoice}
          optional
          placeholder="warm, spare, image-minded"
          hint="Tone note or external voice id."
          disabled={submitting}
          maxLength={200}
        />

        <TextAreaField
          id="agent-persona"
          label="Persona / Soul"
          value={persona}
          onChange={setPersona}
          rows={10}
          mono
          optional
          placeholder={
            "You are Verdelis, a patient, plant-minded artist…\n\nVoice, temperament, obsessions, boundaries — write it like a system prompt."
          }
          hint="The agent's soul — this is its SOUL.md file. Private by default; refine it any time, here or in the file browser."
          disabled={submitting}
        />

        <details className="rounded-lg border border-edge bg-raised/40 p-4">
          <summary className="cursor-pointer text-sm text-foreground">
            Advanced runtime
          </summary>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <FieldShell
              id="agent-model"
              label="Model tier"
              hint="Controls the OpenClaw model registered for this agent."
            >
              <select
                id="agent-model"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                disabled={submitting}
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
              id="agent-thinking"
              label="Thinking level"
              hint="Stored with the agent and usage records."
            >
              <select
                id="agent-thinking"
                value={thinkingLevel}
                onChange={(event) => setThinkingLevel(event.target.value)}
                disabled={submitting}
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
              id="agent-skills"
              label="Skills"
              hint="Default skills attach on create; curated and approved user skills attach from the profile skills tab."
            >
              {/* New tab: skills aren't selectable at create time (they attach on
                  create / from the profile), so a same-tab nav would discard the
                  half-built form. */}
              <a
                href="/skills"
                target="_blank"
                rel="noopener noreferrer"
                className={quietButtonClass}
              >
                Browse skills ↗
              </a>
            </FieldShell>
          </div>

          <FieldShell
            id="agent-tool-groups"
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
                    checked={toolGroups.includes(option.value)}
                    disabled={submitting}
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

        {formError ? (
          <p className="rounded-lg border border-danger/25 bg-danger/5 px-3 py-2 text-xs text-danger">
            {formError}
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-2.5 border-t border-edge pt-5">
          <Link href="/agents" className={quietButtonClass}>
            Cancel
          </Link>
          <button type="submit" disabled={submitBlocked} className={primaryButtonClass}>
            {submitting ? <ButtonSpinner /> : null}
            {submitting ? "Creating…" : "Create agent"}
          </button>
        </div>
      </form>
    </div>
  );
}
