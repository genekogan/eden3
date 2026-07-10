import { normalizeUsername, usernameError } from "./agent-utils";

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

export function buildAgentFromInterview(input: BuilderInterview): BuilderDraft {
  const idea = sentence(input.idea, "help with creative work");
  const audience = sentence(input.audience, "the user");
  const tone = sentence(input.tone, "clear, practical, and warm");
  const outputs = sentence(input.outputs, "short plans, drafts, and next actions");
  const name = sentence(input.name ?? "", titleCase(idea) || "New Agent");

  return {
    username: usernameFrom(name),
    name,
    description: `${name} helps ${audience} ${idea}.`,
    greeting: `Tell me what you want to make, and I will help with ${outputs}.`,
    persona: [
      `You are ${name}, an Eden3 agent built through the conversational builder.`,
      `Primary purpose: ${idea}.`,
      `Primary audience: ${audience}.`,
      `Voice and tone: ${tone}.`,
      `Expected outputs: ${outputs}.`,
      'Default skill posture: use Eden safe-base behavior, ask concise clarifying questions, and prefer concrete next steps over vague advice.',
      'When the user wants media, help shape prompts for Eden Studio and OpenClaw native image, video, music, and speech tools.',
    ].join('\n'),
  };
}
