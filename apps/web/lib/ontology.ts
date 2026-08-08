/**
 * Search and command ontology for the Eden cockpit.
 *
 * This module is intentionally UI-free. Command palettes, help search, and
 * future server-side search adapters can all consume the same typed entries.
 * Dynamic user content belongs to T21c-U01; this registry describes the
 * stable product surface around it.
 */

export type OntologyKind = "page" | "section" | "settings-panel" | "tool" | "action";

/** Ordered from least to most privileged. */
export type OntologyVisibility = "public" | "authenticated" | "agent-owner" | "admin";

export type OntologyScope = "global" | "account" | "agent";

export type OntologyActionKey =
  | "agent.new"
  | "agent.builder"
  | "chat.new"
  | "account.export"
  | "theme.toggle";

export type AgentSectionKey =
  | "chats"
  | "schedule"
  | "workspace"
  | "library"
  | "gateway"
  | "log";

export type AgentSettingsPanelKey =
  | "identity"
  | "persona"
  | "tools"
  | "skills"
  | "memory"
  | "concepts";

export type OntologyHrefTemplate = `/${string}`;

const VALID_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export interface OntologyNavigateTarget {
  type: "navigate";
  /** `:agentUsername` is resolved from the selected-agent context. */
  hrefTemplate: OntologyHrefTemplate;
}

export interface OntologyExecuteTarget {
  type: "execute";
  action: Extract<OntologyActionKey, "account.export" | "theme.toggle">;
}

export type OntologyTarget = OntologyNavigateTarget | OntologyExecuteTarget;

interface OntologyEntryBase {
  /** Stable machine identity. Never derive this from display copy. */
  id: string;
  kind: OntologyKind;
  label: string;
  description?: string;
  /** Lowercase search aliases; label text is searched separately. */
  keywords: readonly string[];
  visibility: OntologyVisibility;
  scope: OntologyScope;
  target: OntologyTarget;
}

export interface OntologyPageEntry extends OntologyEntryBase {
  kind: "page";
}

export interface OntologySectionEntry extends OntologyEntryBase {
  kind: "section";
  scope: "agent";
  section: AgentSectionKey;
}

export interface OntologySettingsEntry extends OntologyEntryBase {
  kind: "settings-panel";
  scope: "agent";
  panel: AgentSettingsPanelKey;
}

export interface OntologyToolEntry extends OntologyEntryBase {
  kind: "tool";
  scope: "global";
  toolName: string;
}

export interface OntologyActionEntry extends OntologyEntryBase {
  kind: "action";
  actionKey: OntologyActionKey;
}

export type OntologyEntry =
  | OntologyPageEntry
  | OntologySectionEntry
  | OntologySettingsEntry
  | OntologyToolEntry
  | OntologyActionEntry;

export interface StudioToolOntologyInput {
  name: string;
  label: string;
  description?: string;
  keywords?: readonly string[];
}

/**
 * The launch fallback inventory. The runtime Studio inventory can replace it
 * via `createOntologyRegistry({ tools })`; tests diff this list against the
 * independently owned Studio fallback catalog.
 */
export const CANONICAL_STUDIO_TOOLS: readonly StudioToolOntologyInput[] = [
  {
    name: "image_generate",
    label: "Image",
    description: "Generate an image from a text prompt.",
    keywords: ["picture", "art", "illustration", "create"],
  },
  {
    name: "video_generate",
    label: "Video",
    description: "Generate a short video clip.",
    keywords: ["movie", "clip", "motion", "create"],
  },
  {
    name: "music_generate",
    label: "Music",
    description: "Compose music from a description.",
    keywords: ["audio", "song", "sound", "create"],
  },
  {
    name: "tts",
    label: "Speech",
    description: "Speak text aloud in an expressive voice.",
    keywords: ["voice", "audio", "text to speech", "create"],
  },
] as const;

const PAGE_ENTRIES = [
  {
    id: "page.agents",
    kind: "page",
    label: "All agents",
    description: "View and choose your agents.",
    keywords: ["directory", "list", "characters"],
    visibility: "authenticated",
    scope: "global",
    target: { type: "navigate", hrefTemplate: "/agents" },
  },
  {
    id: "page.agent.profile",
    kind: "page",
    label: "Agent profile",
    description: "View the selected agent's profile.",
    keywords: ["about", "bio", "public"],
    visibility: "authenticated",
    scope: "agent",
    target: { type: "navigate", hrefTemplate: "/agents/:agentUsername/profile" },
  },
  {
    id: "page.studio",
    kind: "page",
    label: "Studio",
    description: "Create images, video, music, and speech.",
    keywords: ["generate", "media", "create"],
    visibility: "authenticated",
    scope: "global",
    target: { type: "navigate", hrefTemplate: "/studio" },
  },
  {
    id: "page.skills",
    kind: "page",
    label: "Skill library",
    description: "Browse available agent skills.",
    keywords: ["capabilities", "tools", "extensions"],
    visibility: "authenticated",
    scope: "global",
    target: { type: "navigate", hrefTemplate: "/skills" },
  },
  {
    id: "page.collections",
    kind: "page",
    label: "Collections",
    description: "Browse your saved collections.",
    keywords: ["saved", "groups", "media"],
    visibility: "authenticated",
    scope: "account",
    target: { type: "navigate", hrefTemplate: "/collections" },
  },
  {
    id: "page.account",
    kind: "page",
    label: "Account settings",
    description: "View account, subscription, and data settings.",
    keywords: ["profile", "billing", "subscription", "export"],
    visibility: "authenticated",
    scope: "account",
    target: { type: "navigate", hrefTemplate: "/account" },
  },
  {
    id: "page.manna",
    kind: "page",
    label: "Manna",
    description: "View your balance and manna history.",
    keywords: ["balance", "credits", "billing", "top up"],
    visibility: "authenticated",
    scope: "account",
    target: { type: "navigate", hrefTemplate: "/account/manna" },
  },
  {
    id: "page.operator",
    kind: "page",
    label: "Operator",
    description: "Inspect system health and operations.",
    keywords: ["admin", "health", "runtime", "dashboard"],
    visibility: "admin",
    scope: "global",
    target: { type: "navigate", hrefTemplate: "/operator" },
  },
] as const satisfies readonly OntologyPageEntry[];

const AGENT_SECTIONS = [
  {
    section: "chats",
    label: "Chats",
    description: "Browse conversations with the selected agent.",
    keywords: ["sessions", "messages", "conversations"],
  },
  {
    section: "schedule",
    label: "Schedule",
    description: "Manage scheduled work for the selected agent.",
    keywords: ["tasks", "cron", "automation", "recurring"],
  },
  {
    section: "workspace",
    label: "Workspace",
    description: "Browse and edit the selected agent's files.",
    keywords: ["files", "documents", "folder"],
  },
  {
    section: "library",
    label: "Library",
    description: "Browse media created by the selected agent.",
    keywords: ["creations", "images", "video", "audio"],
  },
  {
    section: "gateway",
    label: "Gateway",
    description: "Manage the selected agent's channel connections.",
    keywords: ["connections", "channels", "discord", "telegram"],
  },
  {
    section: "log",
    label: "Log",
    description: "Inspect the selected agent's activity and usage.",
    keywords: ["activity", "history", "usage", "cost"],
  },
] as const satisfies readonly {
  section: AgentSectionKey;
  label: string;
  description: string;
  keywords: readonly string[];
}[];

const SECTION_ENTRIES: readonly OntologySectionEntry[] = AGENT_SECTIONS.map((section) => ({
  id: `section.agent.${section.section}`,
  kind: "section",
  section: section.section,
  label: section.label,
  description: section.description,
  keywords: section.keywords,
  visibility: "authenticated",
  scope: "agent",
  target: {
    type: "navigate",
    hrefTemplate: `/agents/:agentUsername/${section.section}`,
  },
}));

const SETTINGS_PANELS = [
  {
    panel: "identity",
    label: "Settings · Identity",
    description: "Change name, description, avatar, greeting, and voice.",
    keywords: ["profile", "name", "avatar", "greeting", "voice"],
  },
  {
    panel: "persona",
    label: "Settings · Persona",
    description: "Edit the selected agent's personality and SOUL.md.",
    keywords: ["soul", "behavior", "personality", "prompt"],
  },
  {
    panel: "tools",
    label: "Settings · Tools",
    description: "Configure tools, model tier, and thinking level.",
    keywords: ["capabilities", "model", "reasoning", "advanced"],
  },
  {
    panel: "skills",
    label: "Settings · Skills",
    description: "Choose which skills the selected agent may use.",
    keywords: ["allowlist", "capabilities", "extensions"],
  },
  {
    panel: "memory",
    label: "Settings · Memory",
    description: "Inspect, correct, and rebuild agent memory.",
    keywords: ["remember", "corrections", "rebuild", "memory md"],
  },
  {
    panel: "concepts",
    label: "Settings · Concepts",
    description: "Manage the selected agent's reference-image concepts.",
    keywords: ["references", "images", "lora", "character"],
  },
] as const satisfies readonly {
  panel: AgentSettingsPanelKey;
  label: string;
  description: string;
  keywords: readonly string[];
}[];

const SETTINGS_ENTRIES: readonly OntologySettingsEntry[] = SETTINGS_PANELS.map((panel) => ({
  id: `settings.agent.${panel.panel}`,
  kind: "settings-panel",
  panel: panel.panel,
  label: panel.label,
  description: panel.description,
  keywords: panel.keywords,
  visibility: "agent-owner",
  scope: "agent",
  target: {
    type: "navigate",
    hrefTemplate: `/agents/:agentUsername/settings/${panel.panel}`,
  },
}));

const ACTION_ENTRIES = [
  {
    id: "action.chat.new",
    kind: "action",
    actionKey: "chat.new",
    label: "New chat",
    description: "Start a conversation with the selected agent.",
    keywords: ["message", "conversation", "session", "create"],
    visibility: "authenticated",
    scope: "agent",
    target: {
      type: "navigate",
      hrefTemplate: "/agents/:agentUsername/chats/new",
    },
  },
  {
    id: "action.agent.new",
    kind: "action",
    actionKey: "agent.new",
    label: "New agent",
    description: "Create an agent from a template.",
    keywords: ["create", "template", "character"],
    visibility: "authenticated",
    scope: "global",
    target: { type: "navigate", hrefTemplate: "/agents/new" },
  },
  {
    id: "action.agent.builder",
    kind: "action",
    actionKey: "agent.builder",
    label: "Agent builder",
    description: "Create an agent through a guided conversation.",
    keywords: ["create", "conversational", "interview", "bespoke"],
    visibility: "authenticated",
    scope: "global",
    target: { type: "navigate", hrefTemplate: "/agents/builder" },
  },
  {
    id: "action.account.export",
    kind: "action",
    actionKey: "account.export",
    label: "Download account data",
    description: "Export your Eden account as a ZIP archive.",
    keywords: ["export", "backup", "zip", "portable"],
    visibility: "authenticated",
    scope: "account",
    target: { type: "execute", action: "account.export" },
  },
  {
    id: "action.theme.toggle",
    kind: "action",
    actionKey: "theme.toggle",
    label: "Change theme",
    description: "Switch between light, dark, and system appearance.",
    keywords: ["appearance", "light", "dark", "system"],
    visibility: "public",
    scope: "account",
    target: { type: "execute", action: "theme.toggle" },
  },
] as const satisfies readonly OntologyActionEntry[];

const NON_TOOL_ENTRIES: readonly OntologyEntry[] = [
  ...PAGE_ENTRIES,
  ...SECTION_ENTRIES,
  ...SETTINGS_ENTRIES,
  ...ACTION_ENTRIES,
];

const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/;

export function createToolOntologyEntries(
  tools: readonly StudioToolOntologyInput[],
): readonly OntologyToolEntry[] {
  const seen = new Set<string>();
  const canonicalByName = new Map(CANONICAL_STUDIO_TOOLS.map((tool) => [tool.name, tool]));
  return [...tools]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((tool) => {
      if (!TOOL_NAME_PATTERN.test(tool.name)) {
        throw new Error(`Invalid Studio tool name: ${JSON.stringify(tool.name)}`);
      }
      if (seen.has(tool.name)) {
        throw new Error(`Duplicate Studio tool name: ${tool.name}`);
      }
      seen.add(tool.name);
      const canonical = canonicalByName.get(tool.name);
      return {
        id: `tool.${tool.name}`,
        kind: "tool",
        toolName: tool.name,
        label: `Studio · ${tool.label.trim() || tool.name}`,
        description: tool.description ?? canonical?.description,
        keywords: [
          ...new Set([
            tool.name,
            "studio",
            "generate",
            "create",
            ...(canonical?.keywords ?? []),
            ...(tool.keywords ?? []),
          ]),
        ],
        visibility: "authenticated",
        scope: "global",
        target: {
          type: "navigate",
          hrefTemplate: `/studio/${encodeURIComponent(tool.name)}`,
        },
      } satisfies OntologyToolEntry;
    });
}

export interface CreateOntologyRegistryOptions {
  /** Runtime GET /api/studio/tools inventory, or the canonical launch fallback. */
  tools?: readonly StudioToolOntologyInput[];
}

export function createOntologyRegistry(
  options: CreateOntologyRegistryOptions = {},
): readonly OntologyEntry[] {
  const entries = [
    ...NON_TOOL_ENTRIES,
    ...createToolOntologyEntries(options.tools ?? CANONICAL_STUDIO_TOOLS),
  ];
  const problems = validateOntologyRegistry(entries);
  if (problems.length > 0) {
    throw new Error(`Invalid ontology registry:\n${problems.join("\n")}`);
  }
  return entries;
}

export const STATIC_ONTOLOGY_REGISTRY: readonly OntologyEntry[] = createOntologyRegistry();

export interface OntologyContext {
  authenticated: boolean;
  isAdmin?: boolean;
  /** True only when the selected agent belongs to the viewer. */
  isAgentOwner?: boolean;
  /** Raw username; resolution always URL-encodes it. */
  agentUsername?: string | null;
}

export type ResolvedOntologyTarget =
  | { type: "navigate"; href: OntologyHrefTemplate }
  | OntologyExecuteTarget;

export type ResolvedOntologyEntry<T extends OntologyEntry = OntologyEntry> =
  T extends OntologyEntry
    ? Omit<T, "target"> & { target: ResolvedOntologyTarget }
    : never;

export function isOntologyEntryVisible(
  entry: OntologyEntry,
  context: OntologyContext,
): boolean {
  switch (entry.visibility) {
    case "public":
      return true;
    case "authenticated":
      return context.authenticated;
    case "agent-owner":
      return context.authenticated && context.isAgentOwner === true;
    case "admin":
      return context.authenticated && context.isAdmin === true;
  }
}

/** Resolve visibility and selected-agent placeholders in one fail-closed step. */
export function resolveOntologyEntry(
  entry: OntologyEntry,
  context: OntologyContext,
): ResolvedOntologyEntry | null {
  if (!isOntologyEntryVisible(entry, context)) return null;
  if (entry.target.type === "execute") {
    return { ...entry, target: entry.target } as ResolvedOntologyEntry;
  }

  let href: string = entry.target.hrefTemplate;
  if (href.includes(":agentUsername")) {
    const username = context.agentUsername?.trim();
    if (!username) return null;
    href = href.replaceAll(":agentUsername", encodeURIComponent(username));
  }
  return {
    ...entry,
    target: { type: "navigate", href: href as OntologyHrefTemplate },
  } as ResolvedOntologyEntry;
}

export function resolveOntologyRegistry(
  context: OntologyContext,
  entries: readonly OntologyEntry[] = STATIC_ONTOLOGY_REGISTRY,
): readonly ResolvedOntologyEntry[] {
  return entries.flatMap((entry) => {
    const resolved = resolveOntologyEntry(entry, context);
    return resolved ? [resolved] : [];
  });
}

/** Structural invariants cheap enough to run whenever a registry is composed. */
export function validateOntologyRegistry(entries: readonly OntologyEntry[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const targets = new Set<string>();
  const visibilities = new Set<OntologyVisibility>([
    "public",
    "authenticated",
    "agent-owner",
    "admin",
  ]);
  for (const entry of entries) {
    if (!VALID_ID.test(entry.id)) problems.push(`${entry.id}: invalid id`);
    if (ids.has(entry.id)) problems.push(`${entry.id}: duplicate id`);
    ids.add(entry.id);
    if (!entry.label.trim()) problems.push(`${entry.id}: empty label`);
    if (entry.keywords.length === 0) problems.push(`${entry.id}: no search keywords`);
    if (entry.keywords.some((keyword) => !keyword.trim())) {
      problems.push(`${entry.id}: empty search keyword`);
    }
    if (!visibilities.has(entry.visibility)) {
      problems.push(`${entry.id}: invalid visibility`);
    }
    if (entry.scope === "agent" && entry.target.type === "navigate") {
      if (!entry.target.hrefTemplate.includes(":agentUsername")) {
        problems.push(`${entry.id}: agent navigation lacks :agentUsername`);
      }
    }
    if (entry.scope !== "agent" && entry.target.type === "navigate") {
      if (entry.target.hrefTemplate.includes(":agentUsername")) {
        problems.push(`${entry.id}: non-agent navigation uses :agentUsername`);
      }
    }
    if (entry.target.type === "navigate") {
      if (!entry.target.hrefTemplate.startsWith("/") || /\s/.test(entry.target.hrefTemplate)) {
        problems.push(`${entry.id}: invalid navigation target`);
      }
      const unknownPlaceholders = entry.target.hrefTemplate.match(/:[A-Za-z0-9_]+/g) ?? [];
      if (unknownPlaceholders.some((token) => token !== ":agentUsername")) {
        problems.push(`${entry.id}: unknown target placeholder`);
      }
    }
    const targetKey =
      entry.target.type === "navigate"
        ? `navigate:${entry.target.hrefTemplate}`
        : `execute:${entry.target.action}`;
    if (targets.has(targetKey)) problems.push(`${entry.id}: duplicate target ${targetKey}`);
    targets.add(targetKey);
    if (entry.kind === "tool") {
      const expected = `/studio/${encodeURIComponent(entry.toolName)}`;
      if (entry.target.type !== "navigate" || entry.target.hrefTemplate !== expected) {
        problems.push(`${entry.id}: tool target does not match toolName`);
      }
    }
    if (entry.kind === "action" && entry.target.type === "execute") {
      if (entry.actionKey !== entry.target.action) {
        problems.push(`${entry.id}: execute target does not match actionKey`);
      }
    }
  }
  return problems;
}

export interface OntologyInventory {
  /** Searchable Next route templates, independently derived from Next page files. */
  routes: readonly OntologyHrefTemplate[];
  /** Tool names independently derived from the API/fallback Studio inventory. */
  tools: readonly string[];
  /** Panel keys independently derived from settings page folders/nav. */
  settingsPanels: readonly AgentSettingsPanelKey[];
  /** Executable commands for which the consumer has installed handlers. */
  executableActions: readonly OntologyExecuteTarget["action"][];
}

export interface OntologyInventoryDiff {
  missingRoutes: string[];
  unknownRoutes: string[];
  missingTools: string[];
  unknownTools: string[];
  missingSettingsPanels: string[];
  unknownSettingsPanels: string[];
  actionsWithoutHandlers: string[];
  unusedActionHandlers: string[];
}

function sortedDifference(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return [...new Set(left)].filter((value) => !rightSet.has(value)).sort();
}

/**
 * Diff registry claims against independently produced inventories. Consumers
 * own the inventories; accepting them as inputs prevents registry-vs-itself
 * tests, the exact failure mode called out by S20-A.
 */
export function diffOntologyInventory(
  entries: readonly OntologyEntry[],
  inventory: OntologyInventory,
): OntologyInventoryDiff {
  const routeTargets = entries.flatMap((entry) =>
    entry.target.type === "navigate" ? [entry.target.hrefTemplate] : [],
  );
  const tools = entries.flatMap((entry) => (entry.kind === "tool" ? [entry.toolName] : []));
  const panels = entries.flatMap((entry) =>
    entry.kind === "settings-panel" ? [entry.panel] : [],
  );
  const executableActions = entries.flatMap((entry) =>
    entry.target.type === "execute" ? [entry.target.action] : [],
  );
  return {
    missingRoutes: sortedDifference(inventory.routes, routeTargets),
    unknownRoutes: sortedDifference(routeTargets, inventory.routes),
    missingTools: sortedDifference(inventory.tools, tools),
    unknownTools: sortedDifference(tools, inventory.tools),
    missingSettingsPanels: sortedDifference(inventory.settingsPanels, panels),
    unknownSettingsPanels: sortedDifference(panels, inventory.settingsPanels),
    actionsWithoutHandlers: sortedDifference(executableActions, inventory.executableActions),
    unusedActionHandlers: sortedDifference(inventory.executableActions, executableActions),
  };
}

export function isEmptyOntologyInventoryDiff(diff: OntologyInventoryDiff): boolean {
  return Object.values(diff).every((items) => items.length === 0);
}
