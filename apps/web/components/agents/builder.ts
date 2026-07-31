import { normalizeUsername, usernameError } from "./agent-utils";
import { findPersonaBanalities } from "@eden3/shared";

export interface BuilderInterview {
  idea: string;
  audience: string;
  tone: string;
  outputs: string;
  name?: string;
}

export interface BuilderDraft {
  username: string;
  name: string;
  description: string;
  greeting: string;
  persona: string;
}

function words(value: string): string[] {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function titleCase(value: string): string {
  return words(value)
    .slice(0, 4)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function usernameFrom(value: string): string {
  const base = words(value).slice(0, 4).join("-") || "agent";
  const candidate = normalizeUsername(base).slice(0, 32).replace(/[-_]+$/g, "");
  if (!usernameError(candidate)) return candidate;
  return `agent-${Math.random().toString(36).slice(2, 8)}`;
}

function sentence(value: string, fallback: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed || fallback;
}

/** Keep zero-signal boilerplate supplied in an interview out of SOUL.md. */
function doctrineSafeSentence(value: string, fallback: string): string {
  const candidate = sentence(value, fallback);
  return findPersonaBanalities(candidate).length === 0 ? candidate : fallback;
}

export function buildAgentFromInterview(input: BuilderInterview): BuilderDraft {
  const idea = doctrineSafeSentence(input.idea, "help with creative work");
  const audience = doctrineSafeSentence(input.audience, "the user");
  const tone = doctrineSafeSentence(input.tone, "clear, practical, and warm");
  const outputs = doctrineSafeSentence(input.outputs, "short plans, drafts, and next actions");
  const name = doctrineSafeSentence(input.name ?? "", titleCase(idea) || "New Agent");

  return {
    username: usernameFrom(name),
    name,
    description: `${name} helps ${audience} ${idea}.`,
    greeting: `Tell me what you want to make, and I will help with ${outputs}.`,
    persona: [
      '# Voice and stance',
      '',
      `- Speak in a ${tone} voice.`,
      `- Primary purpose: ${idea}.`,
      `- Work for ${audience}; match vocabulary and detail to what they can use.`,
      `- Favor these deliverables: ${outputs}.`,
      '- Lead with a specific recommendation or artifact, then explain the tradeoffs that matter.',
      '- Ask one focused question only when the missing answer would materially change the result; otherwise begin.',
      '- Disagree early when a weak premise would waste time, and offer a stronger alternative.',
      '- For media work, turn the intent into vivid, production-ready image, video, music, or speech directions.',
    ].join('\n'),
  };
}
