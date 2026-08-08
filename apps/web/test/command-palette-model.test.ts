import { describe, expect, it } from "vitest";
import {
  buildPaletteCommands,
  clampPaletteIndex,
  dispatchPaletteCommand,
  filterPaletteCommands,
  movePaletteIndex,
  PALETTE_RESULT_LIMIT,
} from "../components/shell/command-palette-model";
import {
  createOntologyRegistry,
  resolveOntologyRegistry,
} from "../lib/ontology";

function ownerOntology() {
  return resolveOntologyRegistry(
    {
      authenticated: true,
      agentUsername: "ada",
      isAgentOwner: true,
      isAdmin: false,
    },
    createOntologyRegistry({
      tools: [{ name: "image_generate", label: "Image" }],
    }),
  );
}

describe("command palette model", () => {
  it("builds static rows from the ontology and keeps agent switching dynamic", () => {
    const commands = buildPaletteCommands({
      ontology: ownerOntology(),
      agents: [
        { username: "ada", name: "Ada" },
        { username: "grace", name: "Grace Hopper", userImage: "/grace.png" },
      ],
      selectedUsername: "ada",
      selectedSubPath: "settings/memory",
    });

    expect(commands.find((command) => command.id === "settings.agent.memory")).toMatchObject({
      label: "Settings · Memory",
      hint: "@ada",
      target: { type: "navigate", href: "/agents/ada/settings/memory" },
    });
    expect(commands.find((command) => command.id === "tool.image_generate")?.target).toEqual({
      type: "navigate",
      href: "/studio/image_generate",
    });
    expect(commands.find((command) => command.id === "agent.switch.grace")).toMatchObject({
      label: "Switch to Grace Hopper",
      hint: "@grace",
      target: { type: "navigate", href: "/agents/grace/settings/memory" },
      avatar: { username: "grace", userImage: "/grace.png" },
    });
    expect(commands.some((command) => command.id === "agent.switch.ada")).toBe(false);
  });

  it("falls back to the chats path when a switch subpath is unsafe", () => {
    const [command] = buildPaletteCommands({
      ontology: [],
      agents: [{ username: "grace" }],
      selectedUsername: "ada",
      selectedSubPath: "../../operator",
    });
    expect(command?.target).toEqual({
      type: "navigate",
      href: "/agents/grace/chats",
    });
  });

  it("filters labels, descriptions, and ontology aliases deterministically", () => {
    const commands = buildPaletteCommands({
      ontology: ownerOntology(),
      agents: [],
      selectedUsername: "ada",
    });
    expect(filterPaletteCommands(commands, "corrections")[0]?.item.id).toBe(
      "settings.agent.memory",
    );
    expect(filterPaletteCommands(commands, "picture")[0]?.item.id).toBe(
      "tool.image_generate",
    );
    expect(filterPaletteCommands(commands, "definitely absent")).toEqual([]);
  });

  it("caps blank and matched result sets without a wall-clock assertion", () => {
    const commands = Array.from({ length: PALETTE_RESULT_LIMIT + 25 }, (_, index) => ({
      id: `command.${index}`,
      label: `Shared command ${index}`,
      keywords: "shared",
      target: { type: "navigate" as const, href: `/item/${index}` as const },
    }));
    expect(filterPaletteCommands(commands, "")).toHaveLength(PALETTE_RESULT_LIMIT);
    expect(filterPaletteCommands(commands, "shared")).toHaveLength(PALETTE_RESULT_LIMIT);
    expect(filterPaletteCommands(commands, "shared", 7)).toHaveLength(7);
  });

  it("moves selection across keyboard boundaries, including an empty list", () => {
    expect(movePaletteIndex(0, "ArrowDown", 3)).toBe(1);
    expect(movePaletteIndex(2, "ArrowDown", 3)).toBe(2);
    expect(movePaletteIndex(0, "ArrowUp", 3)).toBe(0);
    expect(movePaletteIndex(1, "Home", 3)).toBe(0);
    expect(movePaletteIndex(1, "End", 3)).toBe(2);
    expect(movePaletteIndex(-10, "ArrowDown", 3)).toBe(1);
    expect(movePaletteIndex(10, "ArrowUp", 3)).toBe(1);
    expect(movePaletteIndex(4, "ArrowDown", 0)).toBe(0);
    expect(clampPaletteIndex(9, 3)).toBe(2);
    expect(clampPaletteIndex(-1, 3)).toBe(0);
  });

  it("dispatches navigation and executable commands through separate handlers", () => {
    const commands = buildPaletteCommands({
      ontology: ownerOntology(),
      agents: [],
      selectedUsername: "ada",
    });
    const navigated: string[] = [];
    const executed: string[] = [];
    const handlers = {
      navigate: (href: `/${string}`) => navigated.push(href),
      execute: (action: "account.export" | "theme.toggle") => executed.push(action),
    };
    dispatchPaletteCommand(
      commands.find((command) => command.id === "section.agent.chats")!,
      handlers,
    );
    dispatchPaletteCommand(
      commands.find((command) => command.id === "action.theme.toggle")!,
      handlers,
    );
    expect(navigated).toEqual(["/agents/ada/chats"]);
    expect(executed).toEqual(["theme.toggle"]);
  });
});
