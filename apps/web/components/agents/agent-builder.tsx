"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormEvent } from "react";
import { api } from "@/lib/api";
import { agentHref } from "./agent-card";
import {
  apiErrorDetail,
  normalizeUsername,
  usernameError,
} from "./agent-utils";
import {
  ButtonSpinner,
  FieldShell,
  inputClass,
  primaryButtonClass,
  quietButtonClass,
  TextAreaField,
  TextField,
} from "./form-fields";
import { buildAgentFromInterview, type BuilderDraft } from "./builder";

export function AgentBuilder() {
  const router = useRouter();
  const [idea, setIdea] = useState("");
  const [audience, setAudience] = useState("");
  const [tone, setTone] = useState("");
  const [outputs, setOutputs] = useState("");
  const [draft, setDraft] = useState<BuilderDraft | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const writeDraft = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setDraft(
      buildAgentFromInterview({
        idea,
        audience,
        tone,
        outputs,
      }),
    );
  };

  const createAgent = async () => {
    if (!draft || submitting) return;
    const username = normalizeUsername(draft.username);
    const invalid = usernameError(username);
    if (invalid) {
      setError(invalid);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const agent = await api.agents.create({
        username,
        name: draft.name.trim(),
        description: draft.description.trim(),
        persona: draft.persona.trim(),
        greeting: draft.greeting.trim(),
      });
      router.push(agentHref(agent.username ?? username));
    } catch (caught) {
      setError(apiErrorDetail(caught));
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10 md:px-10">
      <Link
        href="/agents"
        className="font-mono text-xs text-faint transition-colors hover:text-muted"
      >
        ← Agents
      </Link>
      <h1 className="mt-4 text-3xl font-light tracking-tight md:text-4xl">
        Agent builder
      </h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        Answer a short interview, then edit the generated persona before it
        provisions as a normal Eden agent.
      </p>

      <form
        onSubmit={(event) => writeDraft(event)}
        className="mt-8 space-y-5 rounded-xl border border-edge bg-surface p-6"
      >
        <TextAreaField
          id="builder-idea"
          label="What should this agent help with?"
          value={idea}
          onChange={setIdea}
          rows={3}
          placeholder="Curate daily image prompts from my sketchbook notes"
        />
        <TextAreaField
          id="builder-audience"
          label="Who is it for?"
          value={audience}
          onChange={setAudience}
          rows={2}
          placeholder="Me and collaborators on a long-running art project"
          optional
        />
        <TextField
          id="builder-tone"
          label="Tone"
          value={tone}
          onChange={setTone}
          placeholder="sharp, visual, practical"
          optional
        />
        <TextAreaField
          id="builder-outputs"
          label="What should it produce?"
          value={outputs}
          onChange={setOutputs}
          rows={2}
          placeholder="prompt drafts, critique notes, and next experiments"
          optional
        />
        <div className="flex justify-end border-t border-edge pt-5">
          <button
            type="submit"
            disabled={idea.trim().length === 0}
            className={primaryButtonClass}
          >
            Draft agent
          </button>
        </div>
      </form>

      {draft ? (
        <section className="mt-6 space-y-5 rounded-xl border border-edge bg-surface p-6">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-faint">
              Draft
            </p>
            <p className="mt-1 text-sm text-muted">
              Eden will attach the default safe-base skill when this agent is
              created.
            </p>
          </div>
          <FieldShell
            id="builder-username"
            label="Username"
            hint="Permanent @handle."
          >
            <input
              id="builder-username"
              value={draft.username}
              onChange={(event) =>
                setDraft({ ...draft, username: event.target.value })
              }
              className={`${inputClass} font-mono lowercase`}
            />
          </FieldShell>
          <TextField
            id="builder-name"
            label="Name"
            value={draft.name}
            onChange={(name) => setDraft({ ...draft, name })}
          />
          <TextAreaField
            id="builder-description"
            label="Description"
            value={draft.description}
            onChange={(description) => setDraft({ ...draft, description })}
            rows={2}
          />
          <TextAreaField
            id="builder-greeting"
            label="Greeting"
            value={draft.greeting}
            onChange={(greeting) => setDraft({ ...draft, greeting })}
            rows={2}
          />
          <TextAreaField
            id="builder-persona"
            label="Persona"
            value={draft.persona}
            onChange={(persona) => setDraft({ ...draft, persona })}
            rows={10}
            mono
          />
          {error ? (
            <p className="rounded-lg border border-red-400/25 bg-red-400/5 px-3 py-2 text-xs text-red-400">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2.5 border-t border-edge pt-5">
            <Link href="/agents/new" className={quietButtonClass}>
              Use template
            </Link>
            <button
              type="button"
              onClick={() => void createAgent()}
              disabled={submitting}
              className={primaryButtonClass}
            >
              {submitting ? <ButtonSpinner /> : null}
              {submitting ? "Creating…" : "Create agent"}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
