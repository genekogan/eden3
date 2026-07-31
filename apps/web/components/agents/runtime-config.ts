import {
  AGENT_MODEL_OPTIONS,
  AGENT_THINKING_LEVELS,
  AGENT_TOOL_GROUP_OPTIONS,
  DEFAULT_AGENT_MODEL,
  DEFAULT_AGENT_THINKING_LEVEL,
  DEFAULT_AGENT_TOOL_GROUPS,
} from "@/lib/types";

export const MODEL_TIER_OPTIONS = [
  {
    value: AGENT_MODEL_OPTIONS[0],
    label: "Fast",
    detail: "claude-haiku-4-5",
  },
  {
    value: AGENT_MODEL_OPTIONS[1],
    label: "Balanced",
    detail: "claude-sonnet-4-5",
  },
  {
    value: AGENT_MODEL_OPTIONS[2],
    label: "Latest",
    detail: "claude-sonnet-4-6",
  },
  {
    value: AGENT_MODEL_OPTIONS[3],
    label: "Deep",
    detail: "claude-opus-4-6",
  },
] as const;

export const THINKING_LEVEL_OPTIONS = [
  { value: AGENT_THINKING_LEVELS[0], label: "Fast" },
  { value: AGENT_THINKING_LEVELS[1], label: "Balanced" },
  { value: AGENT_THINKING_LEVELS[2], label: "Deep" },
] as const;

export const TOOL_GROUP_OPTIONS = [
  {
    value: "group:runtime",
    label: "Runtime",
    detail: "exec, process, code",
  },
  {
    value: "group:fs",
    label: "Files",
    detail: "read, write, edit",
  },
  {
    value: "group:web",
    label: "Web",
    detail: "search and fetch",
  },
  {
    value: "group:sessions",
    label: "Sessions",
    detail: "history and subagents",
  },
  {
    value: "group:memory",
    label: "Memory",
    detail: "search and recall",
  },
  {
    value: "group:media",
    label: "Media",
    detail: "image, video, audio",
  },
  {
    value: "group:ui",
    label: "Browser/UI",
    detail: "browser and canvas",
  },
  {
    value: "group:automation",
    label: "Automation",
    detail: "cron and heartbeat",
  },
  {
    value: "group:agents",
    label: "Agents",
    detail: "agent directory tools",
  },
  {
    value: "group:plugins",
    label: "Plugins",
    detail: "approved plugin tools",
  },
] as const satisfies ReadonlyArray<{
  value: (typeof AGENT_TOOL_GROUP_OPTIONS)[number];
  label: string;
  detail: string;
}>;

export function normalizeAgentModel(value: string | null | undefined): string {
  return AGENT_MODEL_OPTIONS.includes(value as (typeof AGENT_MODEL_OPTIONS)[number])
    ? value!
    : DEFAULT_AGENT_MODEL;
}

export function normalizeThinkingLevel(value: string | null | undefined): string {
  return AGENT_THINKING_LEVELS.includes(value as (typeof AGENT_THINKING_LEVELS)[number])
    ? value!
    : DEFAULT_AGENT_THINKING_LEVEL;
}

export function normalizeToolGroups(value: readonly string[] | null | undefined): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_AGENT_TOOL_GROUPS];
  const allowed = new Set<string>(AGENT_TOOL_GROUP_OPTIONS);
  const normalized = value.filter((item): item is string => allowed.has(item));
  if (normalized.length > 0 || value.length === 0) return [...new Set(normalized)];
  return [...DEFAULT_AGENT_TOOL_GROUPS];
}
