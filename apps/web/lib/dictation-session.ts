import {
  DictationDraftStore,
  type DictationDraftRecord,
} from "./dictation-storage";

export const MAX_DICTATION_MS = 10 * 60_000;
const MAX_RETRY_DELAY_MS = 5_000;

export interface DictationRemoteSession {
  id: string;
  maxDurationSeconds: number;
}

export interface DictationTransport {
  create(input: { idempotencyKey: string; maxDurationMs: number }): Promise<DictationRemoteSession>;
  uploadChunk(input: {
    sessionId: string;
    index: number;
    audio: Blob;
    sha256: string;
  }): Promise<{ acknowledgedThrough: number }>;
  finalize(input: {
    sessionId: string;
    finalChunkNumber: number;
    idempotencyKey: string;
  }): Promise<{ transcript: string }>;
  cancel(sessionId: string): Promise<void>;
}

export type DictationNetworkPhase = "online" | "retrying";

interface DurableDictationOptions {
  store: DictationDraftStore;
  transport: DictationTransport;
  onNetworkPhase?: (phase: DictationNetworkPhase) => void;
  sleep?: (milliseconds: number) => Promise<void>;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function sha256(blob: Blob): Promise<string> {
  const bytes = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export class DurableDictationSession {
  private draft: DictationDraftRecord;
  private flushPromise: Promise<void> | null = null;
  private closed = false;
  private cancelled = false;
  private networkPhase: DictationNetworkPhase | null = null;

  private constructor(
    draft: DictationDraftRecord,
    private readonly options: DurableDictationOptions,
  ) {
    this.draft = draft;
  }

  static async create(options: DurableDictationOptions): Promise<DurableDictationSession> {
    const remote = await options.transport.create({
      idempotencyKey: crypto.randomUUID(),
      maxDurationMs: MAX_DICTATION_MS,
    });
    const now = Date.now();
    const draft: DictationDraftRecord = {
      id: crypto.randomUUID(),
      remoteId: remote.id,
      finalizeKey: crypto.randomUUID(),
      mimeType: "audio/pcm;rate=16000;channels=1",
      createdAt: now,
      updatedAt: now,
      durationMs: 0,
      nextChunkIndex: 0,
      phase: "recording",
    };
    await options.store.putDraft(draft);
    return new DurableDictationSession(draft, options);
  }

  static recover(
    draft: DictationDraftRecord,
    options: DurableDictationOptions,
  ): DurableDictationSession {
    return new DurableDictationSession(draft, options);
  }

  get durationMs(): number {
    return this.draft.durationMs;
  }

  private reportNetworkPhase(phase: DictationNetworkPhase): void {
    if (this.networkPhase === phase) return;
    this.networkPhase = phase;
    this.options.onNetworkPhase?.(phase);
  }

  async append(audio: Blob, durationMs: number): Promise<void> {
    if (this.closed || this.cancelled || audio.size === 0) return;
    if (durationMs > MAX_DICTATION_MS) {
      throw new Error("Dictation can be at most 10 minutes long.");
    }
    this.draft = await this.options.store.appendChunk(
      this.draft,
      audio,
      durationMs,
    );
    void this.flush();
  }

  private async uploadPending(): Promise<void> {
    let retry = 0;
    while (!this.cancelled) {
      const chunks = await this.options.store.pendingChunks(this.draft.id);
      if (chunks.length === 0) {
        this.reportNetworkPhase("online");
        return;
      }
      const chunk = chunks[0]!;
      try {
        const response = await this.options.transport.uploadChunk({
          sessionId: this.draft.remoteId,
          index: chunk.index,
          audio: chunk.audio,
          sha256: await sha256(chunk.audio),
        });
        await this.options.store.acknowledge(
          this.draft.id,
          response.acknowledgedThrough,
        );
        retry = 0;
        this.reportNetworkPhase("online");
      } catch {
        this.reportNetworkPhase("retrying");
        const delay = Math.min(MAX_RETRY_DELAY_MS, 250 * 2 ** retry);
        retry = Math.min(retry + 1, 5);
        await (this.options.sleep ?? sleep)(delay);
      }
    }
  }

  flush(): Promise<void> {
    if (!this.flushPromise) {
      this.flushPromise = this.uploadPending().finally(() => {
        this.flushPromise = null;
      });
    }
    return this.flushPromise;
  }

  async finish(): Promise<string> {
    if (this.cancelled) throw new Error("Dictation was cancelled.");
    if (this.draft.phase === "complete") {
      this.closed = true;
      return this.draft.transcript?.trim() ?? "";
    }
    if (this.closed) throw new Error("Dictation is already complete.");
    this.draft = await this.options.store.updatePhase(this.draft, "uploading");
    await this.flush();
    this.draft = await this.options.store.updatePhase(this.draft, "finalizing");
    try {
      const result = await this.options.transport.finalize({
        sessionId: this.draft.remoteId,
        finalChunkNumber: this.draft.nextChunkIndex - 1,
        idempotencyKey: this.draft.finalizeKey,
      });
      const transcript = result.transcript.trim();
      this.draft = await this.options.store.complete(this.draft, transcript);
      this.closed = true;
      return transcript;
    } catch (error) {
      this.draft = await this.options.store.updatePhase(this.draft, "failed");
      throw error;
    }
  }

  /** Delete the completed local receipt only after the UI accepted its text. */
  async consume(): Promise<void> {
    if (!this.closed || this.draft.phase !== "complete") return;
    await this.options.store.deleteDraft(this.draft.id);
  }

  async cancel(): Promise<void> {
    if (this.closed || this.cancelled) return;
    this.cancelled = true;
    try {
      await this.options.transport.cancel(this.draft.remoteId);
    } finally {
      await this.options.store.deleteDraft(this.draft.id);
      this.closed = true;
    }
  }
}
