import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SessionRailItem } from "../components/chat/session-rail";
import { sessionTitle } from "../components/chat/chat-api";
import type { SessionDto } from "../lib/types";

const session: SessionDto = {
  id: "00000000-0000-4000-8000-000000000001",
  externalId: null,
  ownerId: "00000000-0000-4000-8000-000000000002",
  title: "Make a picture of a rocketship",
  status: "active",
  sessionType: "web",
  platform: null,
  channelConnectionId: null,
  readOnly: false,
  pinned: false,
  archivedAt: null,
  agentIds: ["00000000-0000-4000-8000-000000000003"],
  userIds: ["00000000-0000-4000-8000-000000000002"],
  agents: [
    {
      id: "00000000-0000-4000-8000-000000000003",
      type: "agent",
      username: "rocket",
      userImage: "/media/rocket.png",
    },
  ],
  lastMessageAt: "2026-08-11T12:00:00.000Z",
  messageCount: 5,
  createdAt: "2026-08-11T11:00:00.000Z",
  updatedAt: "2026-08-11T12:00:00.000Z",
};

describe("agent-scoped conversation rail", () => {
  it("shows conversation identity without repeating the selected agent avatar", () => {
    const html = renderToStaticMarkup(
      <SessionRailItem session={session} href="/agents/rocket/chats/1" active />,
    );

    expect(html).toContain("Make a picture of a rocketship");
    expect(html).toContain("5 messages");
    expect(html).toContain('aria-current="page"');
    expect(html).not.toContain("rocket.png");
    expect(html).not.toContain("<img");
  });

  it("keeps the implementation free of a per-row avatar dependency", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../components/chat/session-rail.tsx"),
      "utf8",
    );
    expect(source).not.toContain('from "@/components/agent-avatar"');
    expect(source).not.toContain("<AgentAvatar");
    expect(source).toContain("<SessionRailItem");
  });

  it("never presents the selected agent name as an untitled conversation", () => {
    expect(sessionTitle({ ...session, title: null })).toBe("New conversation");
  });

  it("wires the real share, rename, pin, archive, and soft-delete actions", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../components/chat/session-rail.tsx"),
      "utf8",
    );
    expect(source).toContain("<SessionShareDialog");
    expect(source).toContain('api.sessions.update(session.id, body)');
    expect(source).toContain('pinned: !session.pinned');
    expect(source).toContain('archived: !archivedView');
    expect(source).toContain('api.sessions.remove(session.id)');
    expect(source).toContain('Existing share links will stop working.');
  });
});
