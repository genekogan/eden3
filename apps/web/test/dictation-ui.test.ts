import { describe, expect, it } from "vitest";

import {
  appendTranscript,
  formatDictationTime,
} from "../components/chat/use-dictation";

describe("dictation UI helpers", () => {
  it("inserts reviewed transcript text without sending or destroying a typed draft", () => {
    expect(appendTranscript("", "  hello there  ")).toBe("hello there");
    expect(appendTranscript("A typed preface", "the spoken continuation")).toBe(
      "A typed preface the spoken continuation",
    );
    expect(appendTranscript("A typed preface\n", "the spoken continuation")).toBe(
      "A typed preface\nthe spoken continuation",
    );
    expect(appendTranscript("unchanged", "   ")).toBe("unchanged");
  });

  it("formats long-recording elapsed time without locale drift", () => {
    expect(formatDictationTime(0)).toBe("0:00");
    expect(formatDictationTime(65_999)).toBe("1:05");
    expect(formatDictationTime(10 * 60_000)).toBe("10:00");
  });
});
