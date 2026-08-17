import { describe, expect, it } from "vitest";
import {
  conversationReducer,
  echoClientId,
  initialConversationState,
  stripMediaSentinelLines,
} from "../components/chat/conversation-state";
import type {
  AssistantStreamItem,
  ConversationAction,
  ConversationState,
  MediaItem,
} from "../components/chat/conversation-state";
import type { MessageDto, SessionEvent } from "../lib/types";
import type { ComposerAttachment } from "../components/chat/composer";

const SESSION_ID = "6c1f5b7e-3d2a-4e8b-9f10-2a3b4c5d6e7f";
const TURN_ID = "0f9e8d7c-6b5a-4433-a221-100f0e0d0c0b";
const TURN_ID_2 = "1f9e8d7c-6b5a-4433-a221-100f0e0d0c0b";
const MSG_ID = "2c1f5b7e-3d2a-4e8b-9f10-2a3b4c5d6e7f";
const CREATION_ID = "3c1f5b7e-3d2a-4e8b-9f10-2a3b4c5d6e7f";
const AT = "2026-07-03T12:00:00.000Z";

function run(
  actions: ConversationAction[],
  from: ConversationState = initialConversationState,
): ConversationState {
  return actions.reduce(conversationReducer, from);
}

function message(overrides: Partial<MessageDto> & { id: string }): MessageDto {
  return {
    externalId: null,
    sessionId: SESSION_ID,
    senderId: null,
    role: "assistant",
    content: "hello",
    attachments: [],
    toolCalls: null,
    reactions: null,
    replyToExternalId: null,
    createdAt: AT,
    ...overrides,
  };
}

function streamEvent(
  clientId: string,
  event: SessionEvent,
  retryContent: string | null = "retry me",
  retryAttachments: ComposerAttachment[] = [],
): ConversationAction {
  return { type: "stream/event", clientId, event, retryContent, retryAttachments, at: AT };
}

function streamItems(state: ConversationState): AssistantStreamItem[] {
  return state.local.filter(
    (item): item is AssistantStreamItem => item.kind === "assistant-stream",
  );
}

describe("stripMediaSentinelLines", () => {
  it("removes raw gateway media paths from mixed text bodies", () => {
    // Observed live (staging chiba): text + trailing MEDIA: container path.
    const body =
      "Here's gene enjoying a sandwich!\n\nMEDIA:/home/node/.openclaw/media/tool-image-generation/image-1---6dc9a993.jpg";
    expect(stripMediaSentinelLines(body)).toBe("Here's gene enjoying a sandwich!");
  });

  it("handles Attachment: spike shape, multiple lines, and media-only bodies", () => {
    expect(
      stripMediaSentinelLines(
        "Attachment: /home/node/.openclaw/media/a.png\nMEDIA:/home/node/.openclaw/media/b.mp4",
      ),
    ).toBe("");
    expect(stripMediaSentinelLines("before\nMEDIA:/x/y.png\nafter")).toBe("before\n\nafter");
  });

  it("leaves ordinary prose intact (only absolute-path values are stripped)", () => {
    expect(stripMediaSentinelLines("MEDIA budgets are fun: attachments matter.")).toBe(
      "MEDIA budgets are fun: attachments matter.",
    );
    expect(stripMediaSentinelLines("Attachment: see the doc I sent earlier")).toBe(
      "Attachment: see the doc I sent earlier",
    );
  });
});

describe("send -> stream lifecycle", () => {
  it("renders echo + streaming bubble, accumulates tokens, finalizes", () => {
    let state = run([{ type: "send", clientId: "c1", content: "hi", at: AT }]);
    expect(state.local.map((i) => i.kind)).toEqual([
      "user-echo",
      "assistant-stream",
    ]);
    expect(state.activeStreamId).toBe("c1");

    state = run(
      [
        streamEvent("c1", {
          type: "turn.started",
          sessionId: SESSION_ID,
          turnId: TURN_ID,
        }),
        streamEvent("c1", { type: "token", turnId: TURN_ID, delta: "he" }),
        streamEvent("c1", { type: "token", turnId: TURN_ID, delta: "llo" }),
      ],
      state,
    );
    const streaming = streamItems(state)[0];
    expect(streaming?.text).toBe("hello");
    expect(streaming?.turnId).toBe(TURN_ID);
    expect(streaming?.phase).toBe("streaming");

    state = run(
      [
        streamEvent("c1", {
          type: "turn.completed",
          turnId: TURN_ID,
          messageId: MSG_ID,
        }),
        { type: "stream/finished", clientId: "c1" },
      ],
      state,
    );
    const done = streamItems(state)[0];
    expect(done?.phase).toBe("done");
    expect(done?.messageId).toBe(MSG_ID);
    expect(state.activeStreamId).toBeNull();
  });

  it("marks the bubble stopped on abort and failed on error", () => {
    const retryAttachments: ComposerAttachment[] = [{
      objectId: "object-review-1",
      attachment: { url: "/objects/object-review-1", mime: "image/png" },
    }];
    const base = run([
      { type: "send", clientId: "c1", content: "hi", at: AT },
      streamEvent("c1", { type: "token", turnId: TURN_ID, delta: "par" }),
    ]);
    const aborted = run([{ type: "stream/aborted", clientId: "c1" }], base);
    expect(streamItems(aborted)[0]?.phase).toBe("stopped");
    expect(streamItems(aborted)[0]?.text).toBe("par");

    const failed = run(
      [
        streamEvent("c1", {
          type: "error",
          turnId: TURN_ID,
          code: "gateway_error",
          message: "boom",
        }, "retry me", retryAttachments),
      ],
      base,
    );
    expect(streamItems(failed)[0]?.phase).toBe("failed");
    const error = failed.local.find((i) => i.kind === "error");
    expect(error && error.kind === "error" && error.retryContent).toBe(
      "retry me",
    );
    expect(error && error.kind === "error" && error.retryAttachments).toEqual(
      retryAttachments,
    );
  });

  it("prunes a failed/stopped bubble that never received text", () => {
    const base = run([{ type: "send", clientId: "c1", content: "hi", at: AT }]);
    const aborted = run([{ type: "stream/aborted", clientId: "c1" }], base);
    expect(streamItems(aborted)).toHaveLength(0);
    // the echo stays — the user's message was accepted
    expect(aborted.local.some((i) => i.kind === "user-echo")).toBe(true);

    const failed = run(
      [
        streamEvent("c1", {
          type: "error",
          turnId: TURN_ID,
          code: "gateway_error",
          message: "boom",
        }),
      ],
      base,
    );
    expect(streamItems(failed)).toHaveLength(0);
    expect(failed.local.some((i) => i.kind === "error")).toBe(true);
  });

  it("send/rejected removes both optimistic bubbles", () => {
    const base = run([{ type: "send", clientId: "c1", content: "hi", at: AT }]);
    const state = run([{ type: "send/rejected", clientId: "c1" }], base);
    expect(state.local).toEqual([]);
    expect(state.activeStreamId).toBeNull();
    expect(echoClientId("c1")).toBe("c1:echo");
  });
});

describe("channel dedupe against the POST stream", () => {
  it("ignores channel token/turn events for a locally-rendered turn", () => {
    const base = run([
      { type: "send", clientId: "c1", content: "hi", at: AT },
      streamEvent("c1", {
        type: "turn.started",
        sessionId: SESSION_ID,
        turnId: TURN_ID,
      }),
      streamEvent("c1", { type: "token", turnId: TURN_ID, delta: "hi" }),
    ]);
    const afterChannel = run(
      [
        {
          type: "channel/event",
          event: { type: "turn.started", sessionId: SESSION_ID, turnId: TURN_ID },
          at: AT,
        },
        {
          type: "channel/event",
          event: { type: "token", turnId: TURN_ID, delta: "hi" },
          at: AT,
        },
      ],
      base,
    );
    expect(streamItems(afterChannel)).toHaveLength(1);
    expect(streamItems(afterChannel)[0]?.text).toBe("hi");
  });

  it("absorbs a channel-first remote bubble when the POST stream claims the turn", () => {
    // channel turn.started races ahead of the POST stream's own event
    const state = run([
      { type: "send", clientId: "c1", content: "hi", at: AT },
      {
        type: "channel/event",
        event: { type: "turn.started", sessionId: SESSION_ID, turnId: TURN_ID },
        at: AT,
      },
      streamEvent("c1", {
        type: "turn.started",
        sessionId: SESSION_ID,
        turnId: TURN_ID,
      }),
      streamEvent("c1", { type: "token", turnId: TURN_ID, delta: "only once" }),
    ]);
    const streams = streamItems(state);
    expect(streams).toHaveLength(1);
    expect(streams[0]?.remote).toBe(false);
    expect(streams[0]?.text).toBe("only once");
  });

  it("renders a remote bubble for turns started elsewhere", () => {
    const state = run([
      {
        type: "channel/event",
        event: { type: "turn.started", sessionId: SESSION_ID, turnId: TURN_ID_2 },
        at: AT,
      },
      {
        type: "channel/event",
        event: { type: "token", turnId: TURN_ID_2, delta: "remote" },
        at: AT,
      },
      {
        type: "channel/event",
        event: { type: "turn.completed", turnId: TURN_ID_2, messageId: MSG_ID },
        at: AT,
      },
    ]);
    const remote = streamItems(state)[0];
    expect(remote?.remote).toBe(true);
    expect(remote?.text).toBe("remote");
    expect(remote?.phase).toBe("done");
  });
});

describe("media lifecycle", () => {
  const attached: SessionEvent = {
    type: "media.attached",
    sessionId: SESSION_ID,
    messageId: MSG_ID,
    url: "/media/ab/cd.png",
    mime: "image/png",
    creationId: CREATION_ID,
  };

  it("reconstructs durable pending work after navigation and clears it at terminal history", () => {
    const restored = run([
      {
        type: "pending/reconcile",
        pending: [{ tool: "video_generate", createdAt: AT }],
      },
    ]);
    expect(restored.local).toContainEqual(
      expect.objectContaining({ kind: "media-pending", tool: "video_generate", at: AT }),
    );

    const terminal = run([{ type: "pending/reconcile", pending: [] }], restored);
    expect(terminal.local.some((item) => item.kind === "media-pending")).toBe(false);
  });

  it("replaces stale live shimmers with the durable authorization set", () => {
    const live = run([
      {
        type: "channel/event",
        event: { type: "media.pending", sessionId: SESSION_ID, tool: "image_generate" },
        at: AT,
      },
    ]);
    const reconciled = run(
      [
        {
          type: "pending/reconcile",
          pending: [{ tool: "music_generate", createdAt: "2026-07-03T12:01:00.000Z" }],
        },
      ],
      live,
    );
    expect(
      reconciled.local
        .filter((item) => item.kind === "media-pending")
        .map((item) => item.tool),
    ).toEqual(["music_generate"]);
  });

  it("shimmer appears on media.pending and retires on media.attached", () => {
    let state = run([
      { type: "send", clientId: "c1", content: "make art", at: AT },
      streamEvent("c1", {
        type: "media.pending",
        sessionId: SESSION_ID,
        tool: "image_generate",
      }),
    ]);
    expect(state.local.some((i) => i.kind === "media-pending")).toBe(true);

    state = run([streamEvent("c1", attached)], state);
    expect(state.local.some((i) => i.kind === "media-pending")).toBe(false);
    const media = state.local.find((i): i is MediaItem => i.kind === "media");
    expect(media?.attachments).toEqual([
      { url: "/media/ab/cd.png", mime: "image/png", creationId: CREATION_ID },
    ]);
  });

  it("applies media.attached exactly once across both transports", () => {
    const base = run([streamEvent("c1", attached)]);
    const again = run(
      [{ type: "channel/event", event: attached, at: AT }],
      base,
    );
    expect(again.local.filter((i) => i.kind === "media")).toHaveLength(1);
  });

  it("keeps ONE media item when the same creation re-homes to a new messageId", () => {
    // The pipeline parks the asset on a transient message (B), then re-homes
    // it onto the real completion row (C) and re-emits media.attached with the
    // SAME creationId but a DIFFERENT messageId. Both events pass the
    // `${messageId}:${creationId}` guard — the merge must key on the creation
    // so the image doesn't briefly render twice.
    const parkedMessageId = "5c1f5b7e-3d2a-4e8b-9f10-2a3b4c5d6e7f";
    const rehomedMessageId = "6c1f5b7e-3d2a-4e8b-9f10-2a3b4c5d6e7f";
    const parked: SessionEvent = {
      type: "media.attached",
      sessionId: SESSION_ID,
      messageId: parkedMessageId,
      url: "/media/ab/cd.png",
      mime: "image/png",
      creationId: CREATION_ID,
    };
    const rehomed: SessionEvent = { ...parked, messageId: rehomedMessageId };

    const state = run([
      { type: "channel/event", event: parked, at: AT },
      { type: "channel/event", event: rehomed, at: AT },
    ]);
    const media = state.local.filter(
      (i): i is MediaItem => i.kind === "media",
    );
    expect(media).toHaveLength(1);
    expect(media[0]?.attachments).toEqual([
      { url: "/media/ab/cd.png", mime: "image/png", creationId: CREATION_ID },
    ]);
  });

  it("shows authoritative channel media.pending during a POST stream and dedupes fallback", () => {
    const active = run([
      { type: "send", clientId: "c1", content: "make art", at: AT },
      {
        type: "channel/event",
        event: {
          type: "media.pending",
          sessionId: SESSION_ID,
          tool: "image_generate",
        },
        at: AT,
      },
      streamEvent("c1", {
        type: "media.pending",
        sessionId: SESSION_ID,
        tool: "unknown",
      }),
    ]);
    expect(active.local.filter((i) => i.kind === "media-pending")).toHaveLength(1);

    const idle = run([
      {
        type: "channel/event",
        event: { type: "media.pending", sessionId: SESSION_ID, tool: "x" },
        at: AT,
      },
    ]);
    expect(idle.local.some((i) => i.kind === "media-pending")).toBe(true);
  });

  it("retires a failed media placeholder and renders a bounded error", () => {
    const state = run([
      {
        type: "channel/event",
        event: {
          type: "media.pending",
          sessionId: SESSION_ID,
          tool: "image_generate",
        },
        at: AT,
      },
      {
        type: "channel/event",
        event: {
          type: "media.failed",
          sessionId: SESSION_ID,
          tool: "image_generate",
          code: "media_tool_failed",
          message: "Media generation failed before producing output.",
        },
        at: AT,
      },
    ]);
    expect(state.local.some((i) => i.kind === "media-pending")).toBe(false);
    expect(state.local).toContainEqual(
      expect.objectContaining({
        kind: "error",
        code: "media_tool_failed",
        message: "Media generation failed before producing output.",
      }),
    );
  });

  it("merges media.attached into a fetched server row when present", () => {
    const withRow = run([
      {
        type: "history/merge",
        messages: [message({ id: MSG_ID, attachments: [] })],
        olderCursor: null,
        position: "init",
      },
      { type: "channel/event", event: attached, at: AT },
    ]);
    expect(withRow.serverMessages[0]?.attachments).toHaveLength(1);
    expect(withRow.local.filter((i) => i.kind === "media")).toHaveLength(0);
  });

  it("retires a live media item when its creation lands on a DIFFERENT row (re-home)", () => {
    // media.attached first referenced a transient message id; history then
    // brings the SAME creation persisted on the real completion row, whose id
    // differs (the pipeline re-homed the attachment and deleted the original).
    // The live item must not linger as a phantom second image.
    const otherRowId = "4c1f5b7e-3d2a-4e8b-9f10-2a3b4c5d6e7f";
    let state = run([streamEvent("c1", attached)]);
    expect(state.local.filter((i) => i.kind === "media")).toHaveLength(1);

    state = run(
      [
        {
          type: "history/merge",
          messages: [
            message({
              id: otherRowId,
              content: "There's your Mars.",
              attachments: [
                { url: "/media/ab/cd.png", mime: "image/png", creationId: CREATION_ID },
              ],
            }),
          ],
          olderCursor: null,
          position: "init",
        },
      ],
      state,
    );
    expect(state.local.filter((i) => i.kind === "media")).toHaveLength(0);
    expect(state.serverMessages[0]?.attachments).toHaveLength(1);
  });
});

describe("history merges + reconciliation", () => {
  it("orders ascending, dedupes by id, pages older without rewinding", () => {
    const older = message({ id: "aaaaaaaa-0000-4000-8000-000000000001", createdAt: "2026-07-03T10:00:00.000Z" });
    const newer = message({ id: "aaaaaaaa-0000-4000-8000-000000000002", createdAt: "2026-07-03T11:00:00.000Z" });
    let state = run([
      {
        type: "history/merge",
        messages: [newer],
        olderCursor: "cur1",
        position: "init",
      },
    ]);
    state = run(
      [
        {
          type: "history/merge",
          messages: [older, newer],
          olderCursor: null,
          position: "older",
        },
      ],
      state,
    );
    expect(state.serverMessages.map((m) => m.id)).toEqual([older.id, newer.id]);
    expect(state.olderCursor).toBeNull();

    // refresh must not rewind the older cursor
    state = run(
      [{ type: "history/merge", messages: [newer], position: "refresh" }],
      state,
    );
    expect(state.olderCursor).toBeNull();
    expect(state.serverMessages).toHaveLength(2);
  });

  it("drops finished local items once their server rows arrive", () => {
    let state = run([
      { type: "send", clientId: "c1", content: "hi", at: AT },
      streamEvent("c1", {
        type: "turn.started",
        sessionId: SESSION_ID,
        turnId: TURN_ID,
      }),
      streamEvent("c1", { type: "token", turnId: TURN_ID, delta: "hello" }),
      streamEvent("c1", {
        type: "turn.completed",
        turnId: TURN_ID,
        messageId: MSG_ID,
      }),
      { type: "stream/finished", clientId: "c1" },
    ]);

    const userRow = message({
      id: "bbbbbbbb-0000-4000-8000-000000000001",
      role: "user",
      content: "hi",
      createdAt: AT,
    });
    const assistantRow = message({
      id: MSG_ID,
      content: "hello",
      createdAt: "2026-07-03T12:00:05.000Z",
    });

    state = run(
      [
        {
          type: "history/merge",
          messages: [userRow, assistantRow],
          position: "refresh",
        },
      ],
      state,
    );
    expect(state.local).toEqual([]);
    expect(state.serverMessages.map((m) => m.id)).toEqual([
      userRow.id,
      assistantRow.id,
    ]);
  });

  it("drops a stopped bubble when the server persisted the partial reply", () => {
    let state = run([
      { type: "send", clientId: "c1", content: "hi", at: AT },
      streamEvent("c1", {
        type: "turn.started",
        sessionId: SESSION_ID,
        turnId: TURN_ID,
      }),
      streamEvent("c1", { type: "token", turnId: TURN_ID, delta: "partial re" }),
      { type: "stream/aborted", clientId: "c1" },
      { type: "stream/finished", clientId: "c1" },
    ]);
    expect(streamItems(state)[0]?.phase).toBe("stopped");

    // refresh returns the persisted row containing the streamed prefix
    state = run(
      [
        {
          type: "history/merge",
          messages: [
            message({
              id: "cccccccc-0000-4000-8000-000000000001",
              content: "partial reply that the server kept",
              createdAt: AT,
            }),
          ],
          position: "refresh",
        },
      ],
      state,
    );
    expect(streamItems(state)).toHaveLength(0);
  });

  it("keeps a still-streaming bubble through a refresh", () => {
    let state = run([
      { type: "send", clientId: "c1", content: "hi", at: AT },
      streamEvent("c1", {
        type: "turn.started",
        sessionId: SESSION_ID,
        turnId: TURN_ID,
      }),
      streamEvent("c1", { type: "token", turnId: TURN_ID, delta: "hel" }),
    ]);
    state = run(
      [
        {
          type: "history/merge",
          messages: [
            message({
              id: "bbbbbbbb-0000-4000-8000-000000000001",
              role: "user",
              content: "hi",
              createdAt: AT,
            }),
          ],
          position: "refresh",
        },
      ],
      state,
    );
    // echo reconciled away; live stream bubble stays
    expect(state.local.map((i) => i.kind)).toEqual(["assistant-stream"]);
    expect(streamItems(state)[0]?.phase).toBe("streaming");
  });
});

describe("adopt (/chat handoff)", () => {
  it("seeds echo + partially-streamed bubble and keeps consuming", () => {
    let state = run([
      {
        type: "adopt",
        clientId: "c9",
        content: "first message",
        text: "par",
        turnId: TURN_ID,
        at: AT,
      },
    ]);
    expect(state.activeStreamId).toBe("c9");
    expect(streamItems(state)[0]?.text).toBe("par");

    state = run(
      [streamEvent("c9", { type: "token", turnId: TURN_ID, delta: "tial" })],
      state,
    );
    expect(streamItems(state)[0]?.text).toBe("partial");
  });
});
