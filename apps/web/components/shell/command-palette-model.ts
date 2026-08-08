import { fuzzyFilter, type FuzzyResult } from "../../lib/fuzzy";
import { agentSectionHref } from "../../lib/eve";
import type { OwnedSearchResultDto } from "../../lib/types";
import type {
  ResolvedOntologyEntry,
  ResolvedOntologyTarget,
} from "../../lib/ontology";

/** Static render bound; the dynamic-content search lane can page beneath it. */
export const PALETTE_RESULT_LIMIT = 50;

export interface PaletteAgent {
  username: string;
  name?: string | null;
  userImage?: string | null;
}

export interface PaletteCommand {
  id: string;
  label: string;
  /** Extra text the fuzzy matcher sees in addition to the label. */
  keywords: string;
  hint?: string;
  target: ResolvedOntologyTarget;
  avatar?: PaletteAgent;
}

export interface PaletteCommandHandlers {
  navigate: (href: `/${string}`) => void;
  execute: (
    action: Extract<ResolvedOntologyTarget, { type: "execute" }>["action"],
  ) => void;
}

/** Exhaustive target dispatch keeps navigation and command execution distinct. */
export function dispatchPaletteCommand(
  command: PaletteCommand,
  handlers: PaletteCommandHandlers,
): void {
  if (command.target.type === "navigate") {
    handlers.navigate(command.target.href);
  } else {
    handlers.execute(command.target.action);
  }
}

export interface BuildPaletteCommandsInput {
  ontology: readonly ResolvedOntologyEntry[];
  agents: readonly PaletteAgent[];
  selectedUsername?: string | null;
  /** Current agent-relative path, used only by dynamic switch commands. */
  selectedSubPath?: string | null;
}

const SAFE_AGENT_SUBPATH = /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/;

/**
 * Adapt the shared ontology to palette rows and append dynamic agent-switch
 * rows. Static page/section/action/tool construction stays in lib/ontology.
 */
export function buildPaletteCommands({
  ontology,
  agents,
  selectedUsername,
  selectedSubPath,
}: BuildPaletteCommandsInput): PaletteCommand[] {
  const commands: PaletteCommand[] = ontology.map((entry) => ({
    id: entry.id,
    label: entry.label,
    keywords: [entry.description ?? "", ...entry.keywords].join(" "),
    hint:
      entry.scope === "agent" && selectedUsername ? `@${selectedUsername}` : undefined,
    target: entry.target,
  }));

  const subPath =
    selectedSubPath && SAFE_AGENT_SUBPATH.test(selectedSubPath)
      ? selectedSubPath
      : "chats";
  for (const agent of agents) {
    if (agent.username === selectedUsername) continue;
    commands.push({
      id: `agent.switch.${encodeURIComponent(agent.username)}`,
      label: `Switch to ${agent.name?.trim() || agent.username}`,
      keywords: `@${agent.username} agent switch`,
      hint: `@${agent.username}`,
      target: {
        type: "navigate",
        href: agentSectionHref(agent.username, subPath) as `/${string}`,
      },
      avatar: agent,
    });
  }
  return commands;
}

export function filterPaletteCommands(
  commands: readonly PaletteCommand[],
  query: string,
  limit = PALETTE_RESULT_LIMIT,
): FuzzyResult<PaletteCommand>[] {
  if (limit <= 0) return [];
  const trimmed = query.trim();
  if (!trimmed) {
    return commands.slice(0, limit).map((item) => ({ item, score: 0 }));
  }
  const results = fuzzyFilter(
    trimmed,
    commands,
    (command) => `${command.label} ${command.keywords}`,
  );
  // A literal label/alias hit must outrank a coincidental subsequence match.
  // The fuzzy scorer still orders fragments when no literal hit exists.
  const needle = trimmed.toLowerCase();
  for (const result of results) {
    const label = result.item.label.toLowerCase();
    const keywords = result.item.keywords.toLowerCase();
    if (label === needle) result.score += 1_000;
    else if (label.includes(needle)) result.score += 500;
    if (keywords.includes(needle)) result.score += 250;
  }
  results.sort((left, right) => right.score - left.score);
  return results.slice(0, limit);
}

const SEARCH_KIND_HINT: Record<OwnedSearchResultDto["kind"], string> = {
  agent: "Agent",
  session: "Chat",
  creation: "Creation",
  collection: "Collection",
  task: "Task",
};

export function searchResultToPaletteCommand(
  result: OwnedSearchResultDto,
): PaletteCommand {
  return {
    id: `content.${result.kind}.${result.id}`,
    label: result.label,
    keywords: result.description ?? "",
    hint: SEARCH_KIND_HINT[result.kind],
    target: result.target,
  };
}

function commandTargetKey(command: PaletteCommand): string {
  return command.target.type === "navigate"
    ? `navigate:${command.target.href}`
    : `execute:${command.target.action}`;
}

/** Merge live owned content with ontology rows, ranking before target dedupe. */
export function mergePaletteResults(
  commands: readonly PaletteCommand[],
  content: readonly OwnedSearchResultDto[],
  query: string,
  limit = PALETTE_RESULT_LIMIT,
): FuzzyResult<PaletteCommand>[] {
  if (limit <= 0) return [];
  const scored = filterPaletteCommands(
    [...commands, ...content.map(searchResultToPaletteCommand)],
    query,
    commands.length + content.length,
  );
  const seenTargets = new Set<string>();
  const merged: FuzzyResult<PaletteCommand>[] = [];
  for (const result of scored) {
    const key = commandTargetKey(result.item);
    if (seenTargets.has(key)) continue;
    seenTargets.add(key);
    merged.push(result);
    if (merged.length === limit) break;
  }
  return merged;
}

export type PaletteMoveKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

export function clampPaletteIndex(index: number, resultCount: number): number {
  if (resultCount <= 0) return 0;
  return Math.max(0, Math.min(index, resultCount - 1));
}

export function movePaletteIndex(
  index: number,
  key: PaletteMoveKey,
  resultCount: number,
): number {
  if (resultCount <= 0) return 0;
  const current = clampPaletteIndex(index, resultCount);
  switch (key) {
    case "ArrowDown":
      return Math.min(current + 1, resultCount - 1);
    case "ArrowUp":
      return Math.max(current - 1, 0);
    case "Home":
      return 0;
    case "End":
      return resultCount - 1;
  }
}
