import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import HelpPage from "../app/help/page";
import { ContextualHelpLink } from "../components/help/contextual-help-link";
import { HelpSearch } from "../components/help/help-search";
import {
  HELP_ARTICLES,
  HELP_ARTICLE_IDS,
  helpHref,
  resolveHelpAction,
  searchHelpArticles,
} from "../lib/help-content";

const SAFE_STATIC_HREFS = new Set(["/agents", "/agents/new", "/account/manna", "/help"]);
const REPO_ROOT = resolve(process.cwd(), "../..");

function expectSafeHelpAction(href: string) {
  expect(href).toMatch(/^\//);
  expect(href).not.toMatch(/(?:^|\/)\.\.(?:\/|$)|[?#](?:account|agent)=|^\/\//);
  expect(
    SAFE_STATIC_HREFS.has(href) ||
      /^\/agents\/[a-zA-Z0-9_-]{1,80}\/(?:chats\/new|library|gateway)$/.test(href),
  ).toBe(true);
}

describe("authenticated help surface", () => {
  it("ships exactly the six first-hour guides with stable anchors", () => {
    expect(HELP_ARTICLES.map((article) => article.id)).toEqual(HELP_ARTICLE_IDS);
    expect(HELP_ARTICLES).toHaveLength(6);
    for (const article of HELP_ARTICLES) {
      expect(helpHref(article.id)).toBe(`/help#${article.id}`);
      expect(article.steps.length).toBeGreaterThanOrEqual(3);
    }

    const html = renderToStaticMarkup(<HelpPage />);
    for (const id of HELP_ARTICLE_IDS) {
      expect(html).toContain(`id="${id}"`);
      expect(html).toContain(`aria-labelledby="${id}-title"`);
    }
  });

  it("searches deterministically in memory and returns a real zero-results state", () => {
    const uploadResults = searchHelpArticles("upload").map((article) => article.id);
    expect(uploadResults[0]).toBe("library-files");
    expect(searchHelpArticles("upload").map((article) => article.id)).toEqual(uploadResults);
    expect(searchHelpArticles("DISCORD bot").map((article) => article.id)).toEqual([
      "connect-channel",
    ]);
    expect(searchHelpArticles("  ")).toBe(HELP_ARTICLES);
    expect(searchHelpArticles("no-such-help-topic")).toEqual([]);

    const zero = renderToStaticMarkup(
      <HelpSearch
        agentAuthority={{ loadedUsername: "gene", phase: "ready", canManage: true }}
        initialQuery="no-such-help-topic"
      />,
    );
    expect(zero).toContain("No help guide matches that search");
    expect(zero).toContain("Show all guides");
    expect(zero).toContain('role="status"');
  });

  it("derives agent actions only from a loaded accessible agent", () => {
    const loadedAccessible = {
      loadedUsername: "gene_1",
      phase: "ready" as const,
      canManage: false,
    };
    const noLoadedAgent = { phase: "loading" as const, canManage: false };

    for (const article of HELP_ARTICLES) {
      expectSafeHelpAction(resolveHelpAction(article, loadedAccessible).href);
      expectSafeHelpAction(resolveHelpAction(article, noLoadedAgent).href);
    }

    const chat = HELP_ARTICLES.find((article) => article.id === "start-chat")!;
    expect(resolveHelpAction(chat, loadedAccessible)).toEqual({
      href: "/agents/gene_1/chats/new",
      label: "Start a chat",
    });
    expect(
      resolveHelpAction(chat, {
        loadedUsername: "victim",
        phase: "loading",
        canManage: false,
      }),
    ).toEqual({
      href: "/agents",
      label: "Choose an agent first",
    });
    expect(
      resolveHelpAction(chat, {
        loadedUsername: "victim",
        phase: "error",
        canManage: false,
      }),
    ).toEqual({ href: "/agents", label: "Choose an agent first" });
    for (const reserved of ["new", "builder"]) {
      expect(
        resolveHelpAction(chat, {
          loadedUsername: reserved,
          phase: "ready",
          canManage: true,
        }),
      ).toEqual({ href: "/agents", label: "Choose an agent first" });
    }

    const library = HELP_ARTICLES.find((article) => article.id === "library-files")!;
    expect(resolveHelpAction(library, loadedAccessible).href).toBe("/agents/gene_1/library");

    const gateway = HELP_ARTICLES.find((article) => article.id === "connect-channel")!;
    expect(resolveHelpAction(gateway, loadedAccessible)).toEqual({
      href: "/agents",
      label: "Choose your own agent",
    });
    for (const managementAuthority of ["owner", "admin"]) {
      expect(
        resolveHelpAction(gateway, {
          loadedUsername: `${managementAuthority}_agent`,
          phase: "ready",
          canManage: true,
        }).href,
      ).toBe(`/agents/${managementAuthority}_agent/gateway`);
    }
    expect(
      resolveHelpAction(gateway, {
        loadedUsername: "eve",
        phase: "ready",
        canManage: true,
      }),
    ).toEqual({ href: "/agents", label: "Choose your own agent" });

    const helpSearchSource = readFileSync(
      resolve(REPO_ROOT, "apps/web/components/help/help-search.tsx"),
      "utf8",
    );
    expect(helpSearchSource).toContain("const { agent, phase, canManage } = useSelectedAgent()");
    expect(helpSearchSource).toContain("loadedUsername: agent?.username");
    expect(helpSearchSource).not.toContain("const { username } = useSelectedAgent()");
  });

  it("renders semantic local search, safe actions, and contextual links", () => {
    const html = renderToStaticMarkup(
      <HelpSearch
        agentAuthority={{ loadedUsername: "gene", phase: "ready", canManage: true }}
      />,
    );
    expect(html).toContain('role="search"');
    expect(html).toContain('type="search"');
    expect(html).toContain('for="help-search"');
    expect(html).toContain("Search stays in this browser");
    for (const href of [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]!)) {
      expectSafeHelpAction(href);
    }

    const contextual = renderToStaticMarkup(
      <ContextualHelpLink topic="safe-errors">Recover safely</ContextualHelpLink>,
    );
    expect(contextual).toContain('aria-haspopup="dialog"');
    expect(contextual).toContain('aria-expanded="false"');
    expect(contextual).not.toContain('href="/help#safe-errors"');
    expect(contextual).toContain("Recover safely");

    const source = readFileSync(
      resolve(REPO_ROOT, "apps/web/components/help/contextual-help-link.tsx"),
      "utf8",
    );
    expect(source).toContain('role="dialog"');
    expect(source).toContain('aria-modal="true"');
    expect(source).toContain('event.key === "Escape"');
    expect(source).toContain("article.steps.map");
  });

  it("keeps contextual links on the four first-use empty states", () => {
    const links = [
      ["apps/web/components/eve/eve-empty-state.tsx", 'topic="choose-agent"'],
      ["apps/web/components/chat/conversation.tsx", 'topic="start-chat"'],
      ["apps/web/app/agents/[username]/library/library-client.tsx", 'topic="library-files"'],
      ["apps/web/app/channels/channels-client.tsx", 'topic="connect-channel"'],
    ] as const;

    for (const [path, marker] of links) {
      const source = readFileSync(resolve(REPO_ROOT, path), "utf8");
      expect(source).toContain("<ContextualHelpLink");
      expect(source).toContain(marker);
    }
  });

  it("pins closed-cohort, media, channel, and test-money truth", () => {
    const html = renderToStaticMarkup(<HelpPage />);
    expect(html).toMatch(/invitation-only test/i);
    expect(html).toMatch(/no public signup/i);
    expect(html).toMatch(/test-mode instruments/i);
    expect(html).toMatch(/not money, stored value, or cryptocurrency/i);
    expect(html).toMatch(/64 MiB each/);
    expect(html).toMatch(/Discord/);
    expect(html).toMatch(/Telegram, follow the Managed Bots ownership flow/);
    expect(html).toMatch(/separate X owner-publishing section/);
    expect(html).toMatch(/never a user token/i);
  });

  it("contains no remote search, dangerous automation, secrets, or internal topology", () => {
    const sources = [
      readFileSync(resolve(REPO_ROOT, "apps/web/lib/help-content.ts"), "utf8"),
      readFileSync(resolve(REPO_ROOT, "apps/web/components/help/help-search.tsx"), "utf8"),
      readFileSync(resolve(REPO_ROOT, "docs/help/FIRST-HOUR.md"), "utf8"),
    ].join("\n");

    expect(sources).not.toMatch(/fetch\(|api\.|console\.|localStorage|sessionStorage/);
    expect(sources).not.toMatch(/auto(?:matically)? (?:retry|send|post|connect)/i);
    expect(sources).not.toMatch(
      /OPENCLAW_GATEWAY_TOKEN|ANTHROPIC_API_KEY|DATABASE_URL|127\.0\.0\.1|postgres(?:ql)?:\/\//i,
    );
    expect(sources).not.toMatch(/(?:sk_live|sk_test|xox[baprs]-|ghp_)[A-Za-z0-9_-]+/);
  });
});
