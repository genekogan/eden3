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
  DICTATION_SIGN_OUT_PURGE_DEADLINE_MS,
  beginDictationPurgeFence,
  clearDictationPurgeFence,
  currentDictationCustodyEpoch,
  currentDictationPurgeFence,
  partitionDictationDrafts,
  purgeDictationDraftsBeforeSignOut,
  resolveDictationPurgeFenceAfterRecovery,
  type DictationDraftRecord,
  type DictationPurgeFenceStore,
} from "../lib/dictation-storage";
import {
  DICTATION_FINALIZE_POLL_TIMEOUT_MS,
  dictationFinalizePollDelay,
} from "../lib/dictation-transport";

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

  it("waits through a full ten-minute realtime replay without hammering status", () => {
    expect(DICTATION_FINALIZE_POLL_TIMEOUT_MS).toBeGreaterThanOrEqual(13 * 60_000);
    expect(dictationFinalizePollDelay(0)).toBe(500);
    expect(dictationFinalizePollDelay(4)).toBeGreaterThanOrEqual(5_000);
    expect(dictationFinalizePollDelay(500)).toBeGreaterThanOrEqual(5_000);
  });

  it("gives sign-out cleanup a bounded commit window without trapping auth", async () => {
    const values = new Map<string, string>();
    const fenceStore: DictationPurgeFenceStore = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    };
    expect(await purgeDictationDraftsBeforeSignOut(async () => undefined, 500, fenceStore)).toBe("purged");
    // Success intentionally remains fenced through the auth transition.
    const successfulEpoch = currentDictationPurgeFence(fenceStore)!;
    expect(successfulEpoch).toBeTruthy();
    clearDictationPurgeFence(successfulEpoch, fenceStore);
    expect(await purgeDictationDraftsBeforeSignOut(async () => {
      throw new Error("indexeddb failed");
    }, 500, fenceStore)).toBe("failed");
    const failedEpoch = currentDictationPurgeFence(fenceStore)!;
    expect(failedEpoch).toBeTruthy();
    clearDictationPurgeFence(failedEpoch, fenceStore);

    const never = new Promise<void>(() => undefined);
    expect(await purgeDictationDraftsBeforeSignOut(
      () => never,
      1,
      fenceStore,
    )).toBe("timed_out");
    const timedOutEpoch = currentDictationPurgeFence(fenceStore)!;
    expect(timedOutEpoch).toBeTruthy();
    clearDictationPurgeFence(timedOutEpoch, fenceStore);
    expect(DICTATION_SIGN_OUT_PURGE_DEADLINE_MS).toBeLessThanOrEqual(500);
  });

  it("invalidates a pre-fence writer even after the recovery purge clears its tombstone", () => {
    const values = new Map<string, string>();
    const fenceStore: DictationPurgeFenceStore = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    };
    const oldEpoch = currentDictationCustodyEpoch(fenceStore);
    const fence = beginDictationPurgeFence(fenceStore);
    expect(currentDictationCustodyEpoch(fenceStore)).not.toBe(oldEpoch);
    clearDictationPurgeFence(fence, fenceStore);
    const delayedDraft = {
      id: "delayed", ownerId: "account-1", custodyEpoch: oldEpoch,
      generation: 1,
      remoteId: "remote", finalizeKey: "finalize", mimeType: "audio/pcm",
      createdAt: 1, updatedAt: 1, durationMs: 1_000, nextChunkIndex: 1, phase: "recording" as const,
    };
    expect(partitionDictationDrafts([delayedDraft], "account-1", 1, currentDictationCustodyEpoch(fenceStore))).toEqual({
      admitted: [], purgeIds: ["delayed"],
    });
  });

  it("clears the tombstone only after authenticated recovery's second purge succeeds", async () => {
    const values = new Map<string, string>();
    const fenceStore: DictationPurgeFenceStore = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    };
    beginDictationPurgeFence(fenceStore);
    const order: string[] = [];
    await resolveDictationPurgeFenceAfterRecovery(async () => {
      order.push("second-purge");
      expect(currentDictationPurgeFence(fenceStore)).toBeTruthy();
    }, fenceStore);
    order.push("recovery-admission");
    expect(order).toEqual(["second-purge", "recovery-admission"]);
    expect(currentDictationPurgeFence(fenceStore)).toBeNull();

    beginDictationPurgeFence(fenceStore);
    await resolveDictationPurgeFenceAfterRecovery(async () => { throw new Error("blocked"); }, fenceStore);
    expect(currentDictationPurgeFence(fenceStore)).toBeTruthy();
    clearDictationPurgeFence(currentDictationPurgeFence(fenceStore)!, fenceStore);
  });

  it("admits only fresh drafts owned by the current authenticated account", () => {
    const now = 2_000_000_000;
    const draft = (id: string, ownerId: string, updatedAt = now): DictationDraftRecord => ({
      id,
      ownerId,
      custodyEpoch: "test-epoch",
      generation: 1,
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
    ], "account-1", now, "test-epoch");
    expect(result.admitted.map((item) => item.id)).toEqual(["mine"]);
    expect(result.purgeIds.sort()).toEqual(["legacy", "other", "stale"]);
  });
});
