import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  appendTranscript,
  formatDictationTime,
} from "../components/chat/use-dictation";
import { PCM_UPLOAD_CHUNK_SAMPLES } from "../lib/pcm-recorder";

const workletSource = readFileSync(
  new URL("../public/audio/pcm-recorder-worklet.js", import.meta.url),
  "utf8",
);

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

  it("batches 16 kHz PCM into one-second durable upload chunks", () => {
    expect(PCM_UPLOAD_CHUNK_SAMPLES).toBe(16_000);
    expect(workletSource).toContain("this.outputChunkSamples = 16000");
  });
});
