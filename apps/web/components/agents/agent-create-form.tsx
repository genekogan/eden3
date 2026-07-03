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
import { useRef, useState } from "react";
import type { FormEvent } from "react";
import { api } from "@/lib/api";
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

interface UsernameState {
  availability: UsernameAvailability;
  /** Validation error (format/reserved) — blocks submit. */
  error: string | null;
  /** The value the availability verdict applies to. */
  checked: string;
}

const IDLE: UsernameState = { availability: "idle", error: null, checked: "" };

function UsernameNote({ state }: { state: UsernameState }) {
  if (state.error) return <p className="text-red-400">{state.error}</p>;
  switch (state.availability) {
    case "checking":
      return <p className="text-faint">Checking @{state.checked}…</p>;
    case "available":
      return <p className="text-emerald-400/90">@{state.checked} is available</p>;
    case "taken":
      return <p className="text-red-400">@{state.checked} is taken</p>;
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
  const [persona, setPersona] = useState("");
  const [usernameState, setUsernameState] = useState<UsernameState>(IDLE);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const probeSeq = useRef(0);

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
      const agent = await api.agents.create({
        username: candidate,
        name: name.trim(),
        description: description.trim(),
        persona: persona.trim(),
        greeting: greeting.trim(),
      });
      router.push(agentHref(agent.username ?? candidate));
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

      <form
        onSubmit={(e) => void onSubmit(e)}
        className="mt-8 space-y-6 rounded-xl border border-edge bg-surface p-6"
      >
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

        <TextAreaField
          id="agent-persona"
          label="Persona"
          value={persona}
          onChange={setPersona}
          rows={10}
          mono
          optional
          placeholder={
            "You are Verdelis, a patient, plant-minded artist…\n\nVoice, temperament, obsessions, boundaries — write it like a system prompt."
          }
          hint="The system prompt. Private by default; you can refine it any time."
          disabled={submitting}
        />

        {formError ? (
          <p className="rounded-lg border border-red-400/25 bg-red-400/5 px-3 py-2 text-xs text-red-400">
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
