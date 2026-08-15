import { describe, expect, it, vi } from "vitest";

import {
  DurableDictationSession,
  DictationTransportError,
  MAX_DICTATION_MS,
  type DictationTransport,
} from "../lib/dictation-session";
import type {
  DictationChunkRecord,
  DictationDraftRecord,
} from "../lib/dictation-storage";

class MemoryDraftStore {
  draft: DictationDraftRecord | null = null;
  chunks: DictationChunkRecord[] = [];

  async putDraft(draft: DictationDraftRecord) { this.draft = draft; }
  async appendChunk(draft: DictationDraftRecord, audio: Blob, durationMs: number) {
    this.chunks.push({ draftId: draft.id, index: draft.nextChunkIndex, bytes: audio.size, audio });
    this.draft = { ...draft, durationMs, nextChunkIndex: draft.nextChunkIndex + 1, updatedAt: Date.now() };
    return this.draft;
  }
  async updatePhase(draft: DictationDraftRecord, phase: DictationDraftRecord["phase"]) {
    this.draft = { ...draft, phase, updatedAt: Date.now() };
    return this.draft;
  }
  async complete(draft: DictationDraftRecord, transcript: string) {
    this.draft = { ...draft, phase: "complete" as const, transcript, updatedAt: Date.now() };
    return this.draft;
  }
  async pendingChunks(draftId: string) { return this.chunks.filter((chunk) => chunk.draftId === draftId); }
  async acknowledge(draftId: string, throughIndex: number) {
    this.chunks = this.chunks.filter((chunk) => chunk.draftId !== draftId || chunk.index > throughIndex);
  }
  async deleteDraft(draftId: string) {
    this.chunks = this.chunks.filter((chunk) => chunk.draftId !== draftId);
    this.draft = null;
  }
}

function transport(overrides: Partial<DictationTransport> = {}): DictationTransport {
  return {
    create: vi.fn(async () => ({ id: "remote-1", maxDurationSeconds: 600 })),
    uploadChunk: vi.fn(async ({ index }) => ({ acknowledgedThrough: index })),
    finalize: vi.fn(async () => ({ transcript: "  A durable transcript.  " })),
    cancel: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("durable dictation session", () => {
  it("persists before upload, retries idempotently, and deletes only after finalization", async () => {
    const events: string[] = [];
    const store = new MemoryDraftStore();
    let attempts = 0;
    const remote = transport({
      uploadChunk: vi.fn(async ({ index }) => {
        events.push(`upload:${index}:local=${store.chunks.length}`);
        if (attempts++ === 0) throw new Error("offline");
        return { acknowledgedThrough: index };
      }),
      finalize: vi.fn(async () => {
        events.push(`finalize:pending=${store.chunks.length}`);
        return { transcript: " recovered words " };
      }),
    });
    const session = await DurableDictationSession.create({
      ownerId: "account-1",
      store: store as never,
      transport: remote,
      sleep: async () => {},
      onNetworkPhase: (phase) => events.push(phase),
    });

    await session.append(new Blob(["audio"]), 1_000);
    expect(await session.finish()).toBe("recovered words");
    expect(store.draft?.phase).toBe("complete");
    await session.consume();
    expect(events).toEqual([
      "upload:0:local=1",
      "retrying",
      "upload:0:local=1",
      "online",
      "finalize:pending=0",
    ]);
    expect(store.draft).toBeNull();
  });

  it("keeps failed finalization recoverable instead of discarding audio state", async () => {
    const store = new MemoryDraftStore();
    const session = await DurableDictationSession.create({
      ownerId: "account-1",
      store: store as never,
      transport: transport({ finalize: vi.fn(async () => { throw new Error("provider down"); }) }),
    });
    await session.append(new Blob(["audio"]), 1_000);
    await expect(session.finish()).rejects.toThrow("provider down");
    expect(store.draft?.phase).toBe("failed");
  });

  it("cancels remotely and erases the private local draft", async () => {
    const store = new MemoryDraftStore();
    const remote = transport();
    const session = await DurableDictationSession.create({
      ownerId: "account-1",
      store: store as never,
      transport: remote,
    });
    await session.cancel();
    expect(remote.cancel).toHaveBeenCalledWith("remote-1");
    expect(store.draft).toBeNull();
  });

  it("refuses audio beyond the ten-minute client guard", async () => {
    const store = new MemoryDraftStore();
    const session = await DurableDictationSession.create({
      ownerId: "account-1",
      store: store as never,
      transport: transport(),
    });
    await expect(session.append(new Blob(["audio"]), MAX_DICTATION_MS + 1)).rejects.toThrow(/10 minutes/);
  });

  it("does not retry permanent authorization or protocol failures", async () => {
    const store = new MemoryDraftStore();
    const uploadChunk = vi.fn(async () => {
      throw new DictationTransportError("Sign in again.", false, 401, "unauthorized");
    });
    const session = await DurableDictationSession.create({
      ownerId: "account-1",
      store: store as never,
      transport: transport({ uploadChunk }),
      sleep: async () => {},
    });
    await session.append(new Blob(["audio"]), 1_000);
    await expect(session.finish()).rejects.toThrow("Sign in again");
    expect(uploadChunk).toHaveBeenCalledTimes(1);
  });

  it("cannot resurrect or finalize a draft cancelled during an in-flight upload", async () => {
    const store = new MemoryDraftStore();
    let releaseUpload!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseUpload = resolve; });
    const finalize = vi.fn(async () => ({ transcript: "must not happen" }));
    const session = await DurableDictationSession.create({
      ownerId: "account-1",
      store: store as never,
      transport: transport({
        uploadChunk: vi.fn(async ({ index }) => {
          await blocked;
          return { acknowledgedThrough: index };
        }),
        finalize,
      }),
    });
    await session.append(new Blob(["audio"]), 1_000);
    const finishing = session.finish();
    const cancelling = session.cancel();
    releaseUpload();
    await cancelling;
    await expect(finishing).rejects.toThrow(/cancelled/);
    expect(finalize).not.toHaveBeenCalled();
    expect(store.draft).toBeNull();
  });
});
