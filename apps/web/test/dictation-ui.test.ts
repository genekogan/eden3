import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  appendTranscript,
  dictationRecoveryDisposition,
  formatDictationTime,
} from "../components/chat/use-dictation";
import { PCM_UPLOAD_CHUNK_SAMPLES } from "../lib/pcm-recorder";
import {
  DICTATION_DRAFT_TTL_MS,
  partitionDictationDrafts,
  type DictationDraftRecord,
} from "../lib/dictation-storage";

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

  it("purges only after authoritative sign-out, never while auth is unresolved", () => {
    expect(dictationRecoveryDisposition("loading", null)).toBe("wait");
    expect(dictationRecoveryDisposition("error", null)).toBe("wait");
    expect(dictationRecoveryDisposition("ready", "account-1")).toBe("recover");
    expect(dictationRecoveryDisposition("signed_out", null)).toBe("purge");
  });

  it("batches 16 kHz PCM into one-second durable upload chunks", () => {
    expect(PCM_UPLOAD_CHUNK_SAMPLES).toBe(16_000);
    expect(workletSource).toContain("this.outputChunkSamples = 16000");
  });

  it("admits only fresh drafts owned by the current authenticated account", () => {
    const now = 2_000_000_000;
    const draft = (id: string, ownerId: string, updatedAt = now): DictationDraftRecord => ({
      id,
      ownerId,
      remoteId: `remote-${id}`,
      finalizeKey: `finalize-${id}`,
      mimeType: "audio/pcm;rate=16000;channels=1",
      createdAt: updatedAt,
      updatedAt,
      durationMs: 1_000,
      nextChunkIndex: 1,
      phase: "recording",
    });
    const legacy = draft("legacy", "account-1") as Partial<DictationDraftRecord>;
    delete legacy.ownerId;
    const result = partitionDictationDrafts([
      draft("mine", "account-1"),
      draft("other", "account-2"),
      draft("stale", "account-1", now - DICTATION_DRAFT_TTL_MS - 1),
      legacy as DictationDraftRecord,
    ], "account-1", now);
    expect(result.admitted.map((item) => item.id)).toEqual(["mine"]);
    expect(result.purgeIds.sort()).toEqual(["legacy", "other", "stale"]);
  });
});
