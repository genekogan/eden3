import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SectionHeader } from "../components/shell/section-header";

const WEB_ROOT = resolve(process.cwd());

function source(path: string): string {
  return readFileSync(resolve(WEB_ROOT, path), "utf8");
}

describe("primary sidebar navigation", () => {
  it("exposes one Chat destination and no runtime database banner", async () => {
    const source = await readFile(
      new URL("../components/shell/sidebar.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain('{ sub: "chats", label: "Chat", icon: ICONS.chats }');
    expect(source).not.toContain('label: "Chats"');
    expect(source).not.toContain("New Chat");
    expect(source).not.toContain("/chats/new");
    expect(source).not.toContain("EnvChip");

    expect(source).toContain('href={mobileChatHref}');
    expect(source).toContain('aria-label="Chat"');
    expect(source).toContain('const active = isActive(href);');
  });

  it("uses the Eden mark as the collapsed expand control", async () => {
    const source = await readFile(
      new URL("../components/shell/sidebar.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain('src="/eden-logo.png"');
    expect(source).not.toContain("overflow-hidden rounded-lg bg-white");
    expect(source).toContain('aria-label="Expand sidebar"');
    expect(source).toContain('aria-label="Collapse sidebar"');
    expect(source).toContain('desktopCollapsed ? (');
    expect(source).not.toContain('"-right-3 z-10 border border-edge bg-surface shadow-lg"');
    expect(source).toContain('window.localStorage.getItem("eden:sidebar-collapsed")');
    expect(source).toContain('data-collapsed={desktopCollapsed ? "true" : "false"}');
    expect(source).toContain('aria-label="Search Eden"');
    expect(source).toContain('title="Search (⌘K)"');
    expect(source).toContain("window.dispatchEvent(new Event(COMMAND_PALETTE_OPEN_EVENT))");

    const palette = await readFile(
      new URL("../components/shell/command-palette.tsx", import.meta.url),
      "utf8",
    );
    expect(palette).toContain('COMMAND_PALETTE_OPEN_EVENT = "eden:command-palette-open"');
    expect(palette).toContain(
      "window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, onOpenRequest)",
    );
  });
});

describe("agent section layout", () => {
  it("keeps explanations behind an accessible compact help control", () => {
    const html = renderToStaticMarkup(
      React.createElement(SectionHeader, {
        title: "Workspace",
        help: "Files this agent works with.",
      }),
    );

    expect(html).toContain("<h1");
    expect(html).toContain("Workspace");
    expect(html).toContain('aria-label="About Workspace"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain("Files this agent works with.");
  });

  it("uses compact title bars instead of repeated agent handles and hero copy", () => {
    for (const path of [
      "app/agents/[username]/workspace/page.tsx",
      "app/agents/[username]/library/page.tsx",
    ]) {
      const page = source(path);
      expect(page).toContain("<SectionHeader");
      expect(page).not.toContain("@{decoded}");
      expect(page).not.toContain('text-3xl font-light');
    }

    const schedule = source("app/tasks/tasks-client.tsx");
    expect(schedule).toContain('title="Schedules"');
    expect(schedule).toContain("actions={newTaskButton}");
    expect(schedule).toContain("sticky");
    expect(schedule).toContain("lg:h-full lg:min-h-0");
    expect(schedule).toContain("lg:flex-1 lg:overflow-y-auto lg:overscroll-contain");
    expect(schedule).toContain('aria-label="Schedule details"');
    expect(schedule).toContain("lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain");
  });

  it("keeps Library focused on media created by agents", () => {
    const library = source("app/agents/[username]/library/library-client.tsx");
    expect(library).not.toContain("UploadPanel");
    expect(library).toContain('["agent", agent?.name || username]');
    expect(library).toContain('["mine", "All agents"]');
    expect(library).toContain('agentOnly: "true"');

    const feed = source("../api/src/routes/feed.ts");
    expect(feed).toContain("agentOnly: z.literal('true').optional()");
    expect(feed).toContain("agentOnly === 'true' ? pg`and c.agent_id is not null`");
  });

  it("places settings hierarchy in a full-height adjacent context rail", () => {
    const settings = source("components/agents/settings/settings-shell.tsx");
    expect(settings).toContain('md:w-56 md:border-b-0 md:border-r');
    expect(settings).toContain('title="Settings"');
    expect(settings).toContain("<SettingsNav username={username} />");
    expect(settings).toContain("<SectionHeader title={title}");
    expect(settings).not.toContain("@{username} · settings");
  });
});
