import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";

import {
  appendTranscript,
  dictationRecoveryDisposition,
  formatDictationTime,
} from "../components/chat/use-dictation";
import { PCM_UPLOAD_CHUNK_SAMPLES } from "../lib/pcm-recorder";
import {
  DICTATION_DRAFT_TTL_MS,
  DICTATION_DB_NAME,
  DICTATION_COMPOSER_DRAFTS_STORAGE_COORDINATE,
  DICTATION_CUSTODY_EPOCH_STORAGE_COORDINATE,
  DICTATION_SIGN_OUT_PURGE_DEADLINE_MS,
  beginDictationPurgeFence,
  commitDictationTranscriptToComposer,
  clearDictationPurgeFence,
  currentDictationCustodyEpoch,
  currentDictationPurgeFence,
  DictationDraftStore,
  loadDictationComposerDraft,
  partitionDictationDrafts,
  persistDictationComposerDraft,
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

function loadRecorderProcessor(): new () => {
  output: number[];
  frameSamples: number;
  port: { postMessage: (message: unknown) => void };
  emit(force: boolean): void;
} {
  let processor: unknown;
  class AudioWorkletProcessor {
    port = {
      onmessage: null,
      postMessage: () => undefined,
    };
  }
  runInNewContext(workletSource, {
    AudioWorkletProcessor,
    Int16Array,
    ArrayBuffer,
    sampleRate: 48_000,
    registerProcessor: (_name: string, value: unknown) => { processor = value; },
  });
  return processor as new () => {
    output: number[];
    frameSamples: number;
    port: { postMessage: (message: unknown) => void };
    emit(force: boolean): void;
  };
}

async function composerRows(indexedDB: IDBFactory): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DICTATION_DB_NAME);
    open.addEventListener("error", () => reject(open.error));
    open.addEventListener("success", () => {
      const database = open.result;
      const transaction = database.transaction("composerDrafts", "readonly");
      const request = transaction.objectStore("composerDrafts").getAll();
      request.addEventListener("success", () => resolve(request.result as Array<Record<string, unknown>>));
      request.addEventListener("error", () => reject(request.error));
      transaction.addEventListener("complete", () => database.close());
    });
  });
}

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

  it("pads only the final PCM tail to a complete 10 ms frame", () => {
    const RecorderProcessor = loadRecorderProcessor();
    const recorder = new RecorderProcessor();
    const emitted: ArrayBuffer[] = [];
    recorder.port.postMessage = (message) => {
      const value = message as { type?: string; samples?: ArrayBuffer };
      if (value.type === "chunk" && value.samples) emitted.push(value.samples);
    };

    recorder.output = new Array(16_000).fill(7);
    recorder.emit(false);
    expect(emitted[0]?.byteLength).toBe(32_000);

    recorder.output = new Array(161).fill(9);
    recorder.emit(true);
    expect(recorder.frameSamples).toBe(160);
    expect(emitted[1]?.byteLength).toBe(640);
    const finalSamples = new Int16Array(emitted[1]!);
    expect([...finalSamples.slice(0, 161)]).toEqual(new Array(161).fill(9));
    expect([...finalSamples.slice(161)]).toEqual(new Array(159).fill(0));
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
    values.set(DICTATION_COMPOSER_DRAFTS_STORAGE_COORDINATE, "legacy private transcript");
    expect(values.has(DICTATION_COMPOSER_DRAFTS_STORAGE_COORDINATE)).toBe(true);
    expect(await purgeDictationDraftsBeforeSignOut(async () => undefined, 500, fenceStore)).toBe("purged");
    expect(values.has(DICTATION_COMPOSER_DRAFTS_STORAGE_COORDINATE)).toBe(false);
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

  it("durably hands a transcript to the composer before audio ack and replays exactly once", async () => {
    const values = new Map<string, string>();
    const fenceStore: DictationPurgeFenceStore = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    };
    const options = { indexedDB: new IDBFactory(), purgeFenceStore: fenceStore };
    await expect(persistDictationComposerDraft("account-1", "session:one", "Typed preface", options)).resolves.toBe(true);
    const first = await commitDictationTranscriptToComposer(
      "account-1", "session:one", "draft-delivery-1", "spoken continuation", options,
    );
    expect(first).toBe("Typed preface spoken continuation");
    // Simulate a crash before IndexedDB acknowledgement: remount hydrates the
    // committed composer text, and replaying the same delivery cannot append.
    await expect(loadDictationComposerDraft("account-1", "session:one", options)).resolves.toBe(first);
    await expect(commitDictationTranscriptToComposer(
      "account-1", "session:one", "draft-delivery-1", "spoken continuation", options,
    )).resolves.toBe(first);
    await expect(loadDictationComposerDraft("account-1", "session:one", options)).resolves.toBe(first);
  });

  it("serializes concurrent cross-tab composer handoffs without losing either transcript", async () => {
    const values = new Map<string, string>();
    const fenceStore: DictationPurgeFenceStore = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    };
    const options = { indexedDB: new IDBFactory(), purgeFenceStore: fenceStore };
    await Promise.all([
      commitDictationTranscriptToComposer("account-1", "session:a", "delivery-a", "alpha", options),
      commitDictationTranscriptToComposer("account-1", "session:b", "delivery-b", "beta", options),
    ]);
    await expect(loadDictationComposerDraft("account-1", "session:a", options)).resolves.toBe("alpha");
    await expect(loadDictationComposerDraft("account-1", "session:b", options)).resolves.toBe("beta");

    await Promise.all([
      commitDictationTranscriptToComposer("account-1", "session:c", "delivery-c1", "one", options),
      commitDictationTranscriptToComposer("account-1", "session:c", "delivery-c2", "two", options),
    ]);
    const sameContext = await loadDictationComposerDraft("account-1", "session:c", options);
    expect(sameContext?.split(" ").sort()).toEqual(["one", "two"]);
    await Promise.all([
      commitDictationTranscriptToComposer("account-1", "session:c", "delivery-c1", "one", options),
      commitDictationTranscriptToComposer("account-1", "session:c", "delivery-c2", "two", options),
    ]);
    expect(await loadDictationComposerDraft("account-1", "session:c", options)).toBe(sameContext);
  });

  it("upgrades existing dictation custody and purges composer handoffs atomically", async () => {
    const indexedDB = new IDBFactory();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(DICTATION_DB_NAME, 2);
      request.addEventListener("upgradeneeded", () => {
        request.result.createObjectStore("drafts", { keyPath: "id" });
        const chunks = request.result.createObjectStore("chunks", { keyPath: ["draftId", "index"] });
        chunks.createIndex("by-draft", "draftId", { unique: false });
      });
      request.addEventListener("success", () => { request.result.close(); resolve(); });
      request.addEventListener("error", () => reject(request.error));
    });
    const values = new Map<string, string>();
    const purgeFenceStore: DictationPurgeFenceStore = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    };
    const options = { indexedDB, purgeFenceStore };
    await persistDictationComposerDraft("account-1", "session:upgrade", "survives upgrade", options);
    await expect(loadDictationComposerDraft("account-1", "session:upgrade", options))
      .resolves.toBe("survives upgrade");
    await new DictationDraftStore(options).purgeAll();
    await expect(loadDictationComposerDraft("account-1", "session:upgrade", options)).resolves.toBeNull();
  });

  it("transactionally imports legacy composer custody and removes plaintext only after commit", async () => {
    const now = Date.now();
    const legacy = JSON.stringify({
      version: 1,
      records: [
        {
          ownerId: "account-1", custodyEpoch: "legacy-epoch", contextKey: "session:legacy",
          value: "typed legacy transcript", deliveryIds: ["delivery-legacy"], updatedAt: now,
        },
        {
          ownerId: "other-account", custodyEpoch: "legacy-epoch", contextKey: "session:foreign",
          value: "foreign", deliveryIds: [], updatedAt: now,
        },
        {
          ownerId: "account-1", custodyEpoch: "old-epoch", contextKey: "session:old",
          value: "old epoch", deliveryIds: [], updatedAt: now,
        },
        {
          ownerId: "account-1", custodyEpoch: "legacy-epoch", contextKey: "session:stale",
          value: "stale", deliveryIds: [], updatedAt: now - DICTATION_DRAFT_TTL_MS - 1,
        },
        { ownerId: 42, value: "malformed" },
      ],
    });
    const values = new Map<string, string>([
      [DICTATION_COMPOSER_DRAFTS_STORAGE_COORDINATE, legacy], [DICTATION_CUSTODY_EPOCH_STORAGE_COORDINATE, "legacy-epoch"],
    ]);
    let failLegacyRemoval = true;
    const purgeFenceStore: DictationPurgeFenceStore = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => {
        if (key === DICTATION_COMPOSER_DRAFTS_STORAGE_COORDINATE && failLegacyRemoval) throw new Error("interrupted after commit");
        values.delete(key);
      },
    };
    const indexedDB = new IDBFactory();
    const options = { indexedDB, purgeFenceStore };
    await expect(loadDictationComposerDraft("account-1", "session:legacy", options))
      .rejects.toThrow("interrupted after commit");
    expect(values.get(DICTATION_COMPOSER_DRAFTS_STORAGE_COORDINATE)).toBe(legacy);

    failLegacyRemoval = false;
    await expect(loadDictationComposerDraft("account-1", "session:legacy", options))
      .resolves.toBe("typed legacy transcript");
    expect(values.has(DICTATION_COMPOSER_DRAFTS_STORAGE_COORDINATE)).toBe(false);
    await expect(composerRows(indexedDB)).resolves.toMatchObject([{
      ownerId: "account-1", custodyEpoch: "legacy-epoch", contextKey: "session:legacy",
    }]);
    // Replay after an interrupted import retains the legacy delivery id, so
    // the same completed dictation cannot append a second time.
    await expect(commitDictationTranscriptToComposer(
      "account-1", "session:legacy", "delivery-legacy", "typed legacy transcript", options,
    )).resolves.toBe("typed legacy transcript");
  });

  it("retains legacy plaintext when IndexedDB migration cannot take custody", async () => {
    const legacy = JSON.stringify({
      version: 1,
      records: [{
        ownerId: "account-1", custodyEpoch: "legacy-epoch", contextKey: "session:legacy",
        value: "must not disappear", deliveryIds: [], updatedAt: Date.now(),
      }],
    });
    const values = new Map<string, string>([
      [DICTATION_COMPOSER_DRAFTS_STORAGE_COORDINATE, legacy], [DICTATION_CUSTODY_EPOCH_STORAGE_COORDINATE, "legacy-epoch"],
    ]);
    const purgeFenceStore: DictationPurgeFenceStore = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    };
    const brokenFactory = { open: () => { throw new Error("indexeddb unavailable"); } } as unknown as IDBFactory;
    await expect(loadDictationComposerDraft("account-1", "session:legacy", {
      indexedDB: brokenFactory, purgeFenceStore,
    })).rejects.toThrow("indexeddb unavailable");
    expect(values.get(DICTATION_COMPOSER_DRAFTS_STORAGE_COORDINATE)).toBe(legacy);
  });

  it("purges an unreadable legacy envelope without admitting any record", async () => {
    const values = new Map<string, string>([
      [DICTATION_COMPOSER_DRAFTS_STORAGE_COORDINATE, "{not-json"], [DICTATION_CUSTODY_EPOCH_STORAGE_COORDINATE, "legacy-epoch"],
    ]);
    const purgeFenceStore: DictationPurgeFenceStore = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    };
    const indexedDB = new IDBFactory();
    await expect(loadDictationComposerDraft("account-1", "session:legacy", {
      indexedDB, purgeFenceStore,
    })).resolves.toBeNull();
    expect(values.has(DICTATION_COMPOSER_DRAFTS_STORAGE_COORDINATE)).toBe(false);
    await expect(composerRows(indexedDB)).resolves.toEqual([]);
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
