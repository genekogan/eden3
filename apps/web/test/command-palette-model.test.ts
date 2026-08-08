import { describe, expect, it } from "vitest";
import {
  buildPaletteCommands,
  clampPaletteIndex,
  dispatchPaletteCommand,
  filterPaletteCommands,
  mergePaletteResults,
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

  it("never switches Eve into a concealed configuration route", () => {
    const [command] = buildPaletteCommands({
      ontology: [],
      agents: [{ username: "eve", name: "Eve" }],
      selectedUsername: "ada",
      selectedSubPath: "settings/persona",
    });
    expect(command?.target).toEqual({
      type: "navigate",
      href: "/agents/eve/chats",
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

  it("merges owned content, ranks exact labels, and dedupes canonical targets", () => {
    const staticCommands = [
      {
        id: "static.agent.ada",
        label: "Open Ada agent",
        keywords: "ada profile",
        target: { type: "navigate" as const, href: "/agents/ada/chats" as const },
      },
      {
        id: "static.plan",
        label: "Planning tools",
        keywords: "quarterly plan",
        target: { type: "navigate" as const, href: "/studio" as const },
      },
    ];
    const content = [
      {
        id: "00000000-0000-4000-8000-000000000001",
        kind: "agent" as const,
        label: "Ada",
        description: "Research agent",
        updatedAt: "2026-08-08T00:00:00.000Z",
        target: { type: "navigate" as const, href: "/agents/ada/chats" as const },
      },
      {
        id: "00000000-0000-4000-8000-000000000002",
        kind: "collection" as const,
        label: "Quarterly plan",
        description: "Reference images",
        updatedAt: "2026-08-08T00:00:00.000Z",
        target: {
          type: "navigate" as const,
          href: "/collections/00000000-0000-4000-8000-000000000002" as const,
        },
      },
    ];

    const ada = mergePaletteResults(staticCommands, content, "ada");
    expect(ada[0]?.item.id).toBe("content.agent.00000000-0000-4000-8000-000000000001");
    expect(
      ada.filter((result) => result.item.target.type === "navigate" && result.item.target.href === "/agents/ada/chats"),
    ).toHaveLength(1);

    const plan = mergePaletteResults(staticCommands, content, "quarterly plan");
    expect(plan[0]?.item.id).toBe(
      "content.collection.00000000-0000-4000-8000-000000000002",
    );
    expect(mergePaletteResults(staticCommands, [], "quarterly plan")).toEqual(
      filterPaletteCommands(staticCommands, "quarterly plan"),
    );
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
