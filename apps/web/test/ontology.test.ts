import { describe, expect, it } from "vitest";
import { FALLBACK_TOOLS } from "../components/studio/catalog";
import {
  CANONICAL_STUDIO_TOOLS,
  STATIC_ONTOLOGY_REGISTRY,
  createOntologyRegistry,
  createToolOntologyEntries,
  diffOntologyInventory,
  isEmptyOntologyInventoryDiff,
  resolveOntologyEntry,
  resolveOntologyRegistry,
  validateOntologyRegistry,
  type AgentSettingsPanelKey,
  type OntologyHrefTemplate,
} from "../lib/ontology";

/*
 * Independent cockpit inventories. Route values were transcribed from the
 * forward cockpit Next page tree and its navigable shell actions, not
 * generated from STATIC_ONTOLOGY_REGISTRY. Once the cockpit branch is merged,
 * an integration test can replace this fixture with a filesystem walk.
 */
const COCKPIT_ROUTE_INVENTORY = [
  "/account",
  "/account/manna",
  "/agents",
  "/agents/:agentUsername/chats",
  "/agents/:agentUsername/chats/new",
  "/agents/:agentUsername/edit",
  "/agents/:agentUsername/gateway",
  "/agents/:agentUsername/library",
  "/agents/:agentUsername/log",
  "/agents/:agentUsername/profile",
  "/agents/:agentUsername/schedule",
  "/agents/:agentUsername/settings/concepts",
  "/agents/:agentUsername/settings/identity",
  "/agents/:agentUsername/settings/memory",
  "/agents/:agentUsername/settings/persona",
  "/agents/:agentUsername/settings/skills",
  "/agents/:agentUsername/settings/tools",
  "/agents/:agentUsername/workspace",
  "/agents/builder",
  "/agents/new",
  "/collections",
  "/operator",
  "/skills",
  "/studio",
  "/studio/image_generate",
  "/studio/music_generate",
  "/studio/tts",
  "/studio/video_generate",
  "/usage",
] as const satisfies readonly OntologyHrefTemplate[];

const SETTINGS_DIRECTORY_INVENTORY = [
  "identity",
  "persona",
  "tools",
  "skills",
  "memory",
  "concepts",
] as const satisfies readonly AgentSettingsPanelKey[];

const EXECUTION_HANDLER_INVENTORY = ["account.export", "theme.toggle"] as const;

describe("cockpit ontology registry", () => {
  it("is structurally valid with globally unique stable ids", () => {
    expect(validateOntologyRegistry(STATIC_ONTOLOGY_REGISTRY)).toEqual([]);
    const ids = STATIC_ONTOLOGY_REGISTRY.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("rejects duplicate targets and invalid visibility metadata", () => {
    const first = STATIC_ONTOLOGY_REGISTRY[0]!;
    const duplicate = {
      ...first,
      id: "page.duplicate",
      visibility: "nobody",
    } as unknown as typeof first;
    expect(validateOntologyRegistry([first, duplicate])).toEqual([
      "page.duplicate: invalid visibility",
      "page.duplicate: duplicate target navigate:/agents",
    ]);
  });

  it("matches independently maintained route, tool, settings, and handler inventories", () => {
    const toolInventory = FALLBACK_TOOLS.map((tool) => tool.name);
    const diff = diffOntologyInventory(STATIC_ONTOLOGY_REGISTRY, {
      routes: COCKPIT_ROUTE_INVENTORY,
      tools: toolInventory,
      settingsPanels: SETTINGS_DIRECTORY_INVENTORY,
      executableActions: EXECUTION_HANDLER_INVENTORY,
    });
    expect(diff).toEqual({
      missingRoutes: [],
      unknownRoutes: [],
      missingTools: [],
      unknownTools: [],
      missingSettingsPanels: [],
      unknownSettingsPanels: [],
      actionsWithoutHandlers: [],
      unusedActionHandlers: [],
    });
    expect(isEmptyOntologyInventoryDiff(diff)).toBe(true);
  });

  it("keeps the static tool contract in sync with the Studio fallback catalog", () => {
    expect(CANONICAL_STUDIO_TOOLS.map((tool) => tool.name).sort()).toEqual(
      FALLBACK_TOOLS.map((tool) => tool.name).sort(),
    );
  });

  it("resolves selected-agent targets with URL encoding", () => {
    const chats = STATIC_ONTOLOGY_REGISTRY.find(
      (entry) => entry.id === "section.agent.chats",
    );
    expect(chats).toBeDefined();
    expect(
      resolveOntologyEntry(chats!, {
        authenticated: true,
        agentUsername: "Ada Lovelace/@eden",
      })?.target,
    ).toEqual({
      type: "navigate",
      href: "/agents/Ada%20Lovelace%2F%40eden/chats",
    });
    expect(resolveOntologyEntry(chats!, { authenticated: true })).toBeNull();
  });

  it("filters owner and admin entries fail-closed", () => {
    const regular = resolveOntologyRegistry({
      authenticated: true,
      agentUsername: "ada",
      isAgentOwner: false,
      isAdmin: false,
    });
    expect(regular.some((entry) => entry.kind === "settings-panel")).toBe(false);
    expect(regular.some((entry) => entry.id === "page.operator")).toBe(false);

    const ownerAdmin = resolveOntologyRegistry({
      authenticated: true,
      agentUsername: "ada",
      isAgentOwner: true,
      isAdmin: true,
    });
    expect(ownerAdmin.filter((entry) => entry.kind === "settings-panel")).toHaveLength(6);
    expect(ownerAdmin.some((entry) => entry.id === "page.operator")).toBe(true);
  });

  it("exposes only explicitly public commands to signed-out viewers", () => {
    expect(resolveOntologyRegistry({ authenticated: false }).map((entry) => entry.id)).toEqual([
      "action.theme.toggle",
    ]);
  });

  it("composes a deterministic runtime tool inventory without mutating the input", () => {
    const tools = [
      { name: "zeta", label: "Zeta" },
      { name: "alpha", label: "Alpha", keywords: ["first"] },
    ] as const;
    expect(createToolOntologyEntries(tools).map((entry) => entry.id)).toEqual([
      "tool.alpha",
      "tool.zeta",
    ]);
    expect(tools.map((tool) => tool.name)).toEqual(["zeta", "alpha"]);
    expect(createOntologyRegistry({ tools }).filter((entry) => entry.kind === "tool")).toHaveLength(
      2,
    );
  });

  it("rejects duplicate and unsafe runtime tool names", () => {
    expect(() =>
      createToolOntologyEntries([
        { name: "image_generate", label: "Image" },
        { name: "image_generate", label: "Image again" },
      ]),
    ).toThrow("Duplicate Studio tool name");
    expect(() =>
      createToolOntologyEntries([{ name: "../../operator", label: "Nope" }]),
    ).toThrow("Invalid Studio tool name");
  });

  it("reports drift in both directions rather than silently accepting it", () => {
    const diff = diffOntologyInventory(STATIC_ONTOLOGY_REGISTRY, {
      routes: ["/agents", "/future"],
      tools: ["image_generate", "future_tool"],
      settingsPanels: ["identity"],
      executableActions: ["theme.toggle"],
    });
    expect(diff.missingRoutes).toEqual(["/future"]);
    expect(diff.unknownRoutes).toContain("/account");
    expect(diff.missingTools).toEqual(["future_tool"]);
    expect(diff.unknownTools).toEqual(["music_generate", "tts", "video_generate"]);
    expect(diff.unknownSettingsPanels).toEqual([
      "concepts",
      "memory",
      "persona",
      "skills",
      "tools",
    ]);
    expect(diff.actionsWithoutHandlers).toEqual(["account.export"]);
    expect(isEmptyOntologyInventoryDiff(diff)).toBe(false);
  });
});
