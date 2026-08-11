import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import {
  EveEmptyState,
} from "../components/eve/eve-empty-state";
import {
  agentSectionHref,
  agentSettingsLandingHref,
  agentSubpathForUsername,
  isEveConfigurationHref,
  isEveConcealedSubpath,
  isEveUsername,
} from "../lib/eve";
import { middleware } from "../middleware";

const WEB_ROOT = resolve(import.meta.dirname, "..");

describe("eve empty-state entry", () => {
  it("pins eve without gating creation of the user's own agent", () => {
    const html = renderToStaticMarkup(<EveEmptyState />);
    expect(html).toContain("@eve");
    expect(html).toContain('href="/agents/eve/chats/new"');
    expect(html).toContain('href="/agents/builder"');
    expect(html).toContain("Make me my own agent");
    expect(html).toContain('href="/agents/new"');
    expect(html).not.toContain("/settings");
  });

  it("keeps the Eve invitation in the directory without duplicating it in the sidebar", () => {
    const directory = readFileSync(
      resolve(WEB_ROOT, "components/agents/agents-directory.tsx"),
      "utf8",
    );
    const sidebar = readFileSync(
      resolve(WEB_ROOT, "components/shell/sidebar.tsx"),
      "utf8",
    );
    const selector = readFileSync(
      resolve(WEB_ROOT, "components/shell/agent-selector.tsx"),
      "utf8",
    );

    expect(directory).toContain("<EveEmptyState />");
    expect(sidebar).not.toContain("EveSidebarEntry");
    expect(sidebar).not.toContain('data-testid="eve-sidebar-entry"');
    expect(sidebar).toContain("!isEveUsername(username) || !isEveConcealedSubpath(item.sub)");
    expect(selector).toContain("@eve · Eden guide");
  });
});

describe("eve settings concealment", () => {
  it("recognizes the singular identity case-insensitively", () => {
    expect(isEveUsername("eve")).toBe(true);
    expect(isEveUsername("EVE")).toBe(true);
    expect(isEveUsername("steve")).toBe(false);
  });

  it.each([
    "edit",
    "settings",
    "settings/persona",
    "schedule",
    "workspace",
    "gateway",
  ])("conceals Eve's %s route", (subpath) => {
    expect(isEveConcealedSubpath(subpath)).toBe(true);
    expect(agentSubpathForUsername("eve", subpath)).toBe("chats");
    expect(agentSectionHref("eve", subpath)).toBe("/agents/eve/chats");
  });

  it.each(["chats", "chats/new", "library", "log"])(
    "keeps Eve's %s route available",
    (subpath) => {
      expect(isEveConcealedSubpath(subpath)).toBe(false);
      expect(agentSubpathForUsername("eve", subpath)).toBe(subpath);
    },
  );

  it("leaves normal agent settings intact", () => {
    expect(agentSectionHref("verdalis", "settings/persona")).toBe(
      "/agents/verdalis/settings/persona",
    );
    expect(agentSettingsLandingHref("verdalis")).toBe(
      "/agents/verdalis/settings/identity",
    );
  });

  it("recognizes only Eve configuration URLs", () => {
    expect(isEveConfigurationHref("eve", "/agents/eve/settings/persona")).toBe(true);
    expect(isEveConfigurationHref("eve", "/agents/eve/chats")).toBe(false);
    expect(isEveConfigurationHref("ada", "/agents/ada/settings/persona")).toBe(false);
  });

  it("redirects every Eve settings landing path to chats", () => {
    expect(agentSettingsLandingHref("eve")).toBe("/agents/eve/chats");
    const settingsLayout = readFileSync(
      resolve(WEB_ROOT, "app/agents/[username]/settings/layout.tsx"),
      "utf8",
    );
    const legacyEdit = readFileSync(
      resolve(WEB_ROOT, "app/agents/[username]/edit/page.tsx"),
      "utf8",
    );
    expect(settingsLayout).toContain("isEveUsername(username)");
    expect(legacyEdit).toContain("agentSettingsLandingHref");
  });

  it.each([
    "settings",
    "settings/persona",
    "edit",
    "schedule",
    "workspace",
    "gateway",
  ])(
    "redirects Eve's %s route before rendering config markup",
    (subpath) => {
      const response = middleware(
        new NextRequest(`https://eden.test/agents/eve/${subpath}`),
      );
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(
        "https://eden.test/agents/eve/chats",
      );
    },
  );

  it("does not redirect another agent's settings", () => {
    const response = middleware(
      new NextRequest("https://eden.test/agents/verdalis/settings/persona"),
    );
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("filters generated Eve config links from sidebar, selector, and command palette", () => {
    for (const path of [
      "components/shell/sidebar.tsx",
    ]) {
      const source = readFileSync(resolve(WEB_ROOT, path), "utf8");
      expect(source).toContain("isEveConcealedSubpath");
    }
    const palette = readFileSync(
      resolve(WEB_ROOT, "components/shell/command-palette.tsx"),
      "utf8",
    );
    expect(palette).toContain("isEveConfigurationHref");
    const selector = readFileSync(
      resolve(WEB_ROOT, "components/shell/agent-selector.tsx"),
      "utf8",
    );
    expect(selector).toContain("agentSubpathForUsername");
  });
});
