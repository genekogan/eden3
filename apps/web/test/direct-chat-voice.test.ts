import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  directVoiceNoteIdempotencyKey,
  directVoiceNoteRetryKey,
} from "../components/chat/chat-api";

const conversationSource = readFileSync(
  new URL("../components/chat/conversation.tsx", import.meta.url),
  "utf8",
);
const bubbleSource = readFileSync(
  new URL("../components/chat/message-bubble.tsx", import.meta.url),
  "utf8",
);

describe("direct-chat voice notes", () => {
  it("reuses one stable message-bound key across refresh and manual retries", () => {
    const id = "88888888-8888-4888-8888-888888888888";
    expect(directVoiceNoteIdempotencyKey(id)).toBe(`direct-voice:${id}`);
    expect(directVoiceNoteIdempotencyKey(id)).toBe(directVoiceNoteIdempotencyKey(id));
    expect(directVoiceNoteRetryKey(id, "attempt-2")).toBe(`direct-voice:${id}:retry:attempt-2`);
    expect(conversationSource).toContain('code !== "voice_execution_terminal"');
    expect(conversationSource).toContain("voiceRequestKeysRef.current.set(messageId, key)");
  });

  it("offers on-demand playback only for eligible unvoiced assistant rows", () => {
    expect(conversationSource).toContain("api.sessions.voiceNote(");
    expect(conversationSource).toContain('message.role === "assistant"');
    expect(conversationSource).toContain("attachment.voiceExecutionId");
    expect(conversationSource).toContain('delivery.chat === "on_demand"');
    expect(conversationSource).toContain('delivery.chat === "always"');
    expect(bubbleSource).toContain('aria-label={label}');
    expect(bubbleSource).toContain('"Retry voice note"');
  });
});
