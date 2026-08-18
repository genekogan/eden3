/**
 * Browser-local write-ahead log for long dictation recordings.
 *
 * Audio chunks are committed to IndexedDB before any network upload. A server
 * acknowledgement removes only the acknowledged chunks, leaving enough state
 * to resume/finalize after a refresh or a short network outage. The database
 * contains private transient audio, so completed/cancelled drafts are deleted
 * immediately and abandoned drafts are bounded by the backend/local TTL.
 */

export const DICTATION_DB_NAME = "eden3-dictation-v1";
const DICTATION_DB_VERSION = 3;
export const DICTATION_DRAFT_TTL_MS = 6 * 60 * 60_000;
export const DICTATION_PURGE_FENCE_STORAGE_COORDINATE = "eden3.dictation.purge-epoch.v1";
export const DICTATION_CUSTODY_EPOCH_STORAGE_COORDINATE = "eden3.dictation.custody-epoch.v1";
export const DICTATION_COMPOSER_DRAFTS_STORAGE_COORDINATE = "eden3.dictation.composer-drafts.v1";
const DICTATION_PURGE_EVENT = "eden3:dictation-purge";
const DRAFTS = "drafts";
const CHUNKS = "chunks";
const COMPOSER_DRAFTS = "composerDrafts";

export type DictationDraftPhase =
  | "recording"
  | "uploading"
  | "finalizing"
  | "complete"
  | "failed";

export interface DictationDraftRecord {
  id: string;
  ownerId: string;
  custodyEpoch: string;
  /** Monotonic IndexedDB lease. Every mutating writer must hold this value. */
  generation: number;
  remoteId: string;
  finalizeKey: string;
  mimeType: string;
  createdAt: number;
  updatedAt: number;
  durationMs: number;
  nextChunkIndex: number;
  phase: DictationDraftPhase;
  transcript?: string;
}

export interface DictationChunkRecord {
  draftId: string;
  index: number;
  bytes: number;
  audio: Blob;
}

export class DictationDraftSupersededError extends Error {
  constructor() {
    super("This dictation was resumed in another view.");
    this.name = "DictationDraftSupersededError";
  }
}

export interface DictationPurgeFenceStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface DictationComposerDraftRecord {
  key: string;
  ownerId: string;
  custodyEpoch: string;
  contextKey: string;
  value: string;
  deliveryIds: string[];
  updatedAt: number;
}

interface LegacyDictationComposerDraftEnvelope {
  version: 1;
  records: Array<Omit<DictationComposerDraftRecord, "key">>;
}

export interface DictationDbOptions {
  indexedDB?: IDBFactory;
  purgeFenceStore?: DictationPurgeFenceStore;
}

let memoryPurgeFence: string | null = null;
let memoryPurgeFallback = false;
let memoryCustodyEpoch = "initial";

function browserFenceStore(): DictationPurgeFenceStore | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}

export function currentDictationPurgeFence(store = browserFenceStore()): string | null {
  try {
    const durable = store?.getItem(DICTATION_PURGE_FENCE_STORAGE_COORDINATE) ?? null;
    return durable ?? (memoryPurgeFallback ? memoryPurgeFence : null);
  }
  catch { return memoryPurgeFence; }
}

export function currentDictationCustodyEpoch(store = browserFenceStore()): string {
  try { return store?.getItem(DICTATION_CUSTODY_EPOCH_STORAGE_COORDINATE) ?? memoryCustodyEpoch; }
  catch { return memoryCustodyEpoch; }
}

export function beginDictationPurgeFence(store = browserFenceStore()): string {
  const epoch = `${Date.now()}:${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
  memoryPurgeFence = epoch;
  memoryPurgeFallback = true;
  memoryCustodyEpoch = epoch;
  try {
    store?.setItem(DICTATION_CUSTODY_EPOCH_STORAGE_COORDINATE, epoch);
    store?.setItem(DICTATION_PURGE_FENCE_STORAGE_COORDINATE, epoch);
    // Composer handoffs contain the delivered plaintext transcript. They are
    // part of microphone custody and must cross no authentication boundary.
    store?.removeItem(DICTATION_COMPOSER_DRAFTS_STORAGE_COORDINATE);
    if (store) memoryPurgeFallback = false;
  } catch { /* memory remains fail-closed */ }
  try { globalThis.dispatchEvent?.(new CustomEvent(DICTATION_PURGE_EVENT, { detail: epoch })); } catch { /* non-window/test runtime */ }
  return epoch;
}

function composerDraftKey(ownerId: string, custodyEpoch: string, contextKey: string): string {
  return JSON.stringify([ownerId, custodyEpoch, contextKey]);
}

function parseLegacyComposerDrafts(raw: string): Array<Omit<DictationComposerDraftRecord, "key">> {
  let decoded: Partial<LegacyDictationComposerDraftEnvelope> | null = null;
  try { decoded = JSON.parse(raw) as Partial<LegacyDictationComposerDraftEnvelope> | null; }
  catch { return []; }
  if (decoded?.version !== 1 || !Array.isArray(decoded.records) || decoded.records.length > 20) {
    return [];
  }
  return decoded.records.flatMap((record) => {
    if (!record || typeof record.ownerId !== "string" || !record.ownerId ||
      typeof record.custodyEpoch !== "string" || !record.custodyEpoch ||
      typeof record.contextKey !== "string" || !record.contextKey ||
      typeof record.value !== "string" || record.value.length > 2_000_000 ||
      !Array.isArray(record.deliveryIds) || record.deliveryIds.length > 32 ||
      record.deliveryIds.some((id) => typeof id !== "string" || !id) ||
      !Number.isFinite(record.updatedAt)) {
      return [];
    }
    return [record];
  });
}

/** One-time v2 localStorage -> v3 IndexedDB custody transfer. */
async function importLegacyComposerDrafts(ownerId: string, options?: DictationDbOptions): Promise<void> {
  const store = options?.purgeFenceStore ?? browserFenceStore();
  if (!store || currentDictationPurgeFence(store)) return;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const raw = store.getItem(DICTATION_COMPOSER_DRAFTS_STORAGE_COORDINATE);
    if (!raw) return;
    const epoch = currentDictationCustodyEpoch(store);
    const now = Date.now();
    const records = parseLegacyComposerDrafts(raw).filter((record) =>
      record.ownerId === ownerId && record.custodyEpoch === epoch &&
      now - record.updatedAt <= DICTATION_DRAFT_TTL_MS,
    );
    await withDatabase(options, async (database) => {
      const transaction = database.transaction(COMPOSER_DRAFTS, "readwrite");
      const drafts = transaction.objectStore(COMPOSER_DRAFTS);
      if (currentDictationPurgeFence(store)) {
        transaction.abort();
        throw new Error("Dictation custody is being cleared for sign-out.");
      }
      for (const legacy of records) {
        const key = composerDraftKey(legacy.ownerId, legacy.custodyEpoch, legacy.contextKey);
        const current = await requestResult(drafts.get(key) as IDBRequest<DictationComposerDraftRecord | undefined>);
        if (currentDictationPurgeFence(store)) {
          transaction.abort();
          throw new Error("Dictation custody is being cleared for sign-out.");
        }
        const deliveryIds = [...new Set([...(current?.deliveryIds ?? []), ...legacy.deliveryIds])].slice(-32);
        drafts.put({
          ...(current && current.updatedAt > legacy.updatedAt ? current : legacy),
          key,
          deliveryIds,
          updatedAt: Math.max(current?.updatedAt ?? 0, legacy.updatedAt),
        } satisfies DictationComposerDraftRecord);
      }
      await transactionDone(transaction);
    });
    // Never erase the only plaintext copy before the IDB transaction commits.
    if (store.getItem(DICTATION_COMPOSER_DRAFTS_STORAGE_COORDINATE) === raw) {
      store.removeItem(DICTATION_COMPOSER_DRAFTS_STORAGE_COORDINATE);
      return;
    }
  }
  throw new Error("Legacy dictation composer custody changed during migration.");
}

/** Restore the exact locally-durable composer text for this account/view. */
export async function loadDictationComposerDraft(
  ownerId: string,
  contextKey: string,
  options?: DictationDbOptions,
): Promise<string | null> {
  const store = options?.purgeFenceStore ?? browserFenceStore();
  if (currentDictationPurgeFence(store)) return null;
  await importLegacyComposerDrafts(ownerId, options);
  const epoch = currentDictationCustodyEpoch(store);
  const key = composerDraftKey(ownerId, epoch, contextKey);
  return withDatabase(options, async (database) => {
    const transaction = database.transaction(COMPOSER_DRAFTS, "readwrite");
    const drafts = transaction.objectStore(COMPOSER_DRAFTS);
    if (currentDictationPurgeFence(store) || currentDictationCustodyEpoch(store) !== epoch) {
      transaction.abort();
      return null;
    }
    const all = await requestResult(drafts.getAll() as IDBRequest<DictationComposerDraftRecord[]>);
    if (currentDictationPurgeFence(store) || currentDictationCustodyEpoch(store) !== epoch) {
      transaction.abort();
      return null;
    }
    const now = Date.now();
    let matched: DictationComposerDraftRecord | null = null;
    for (const record of all) {
      const admitted = record.ownerId === ownerId && record.custodyEpoch === epoch &&
        now - record.updatedAt <= DICTATION_DRAFT_TTL_MS;
      if (!admitted) drafts.delete(record.key);
      else if (record.key === key) matched = record;
    }
    await transactionDone(transaction);
    return matched?.value ?? null;
  });
}

/** Persist ordinary edits so a delivered transcript cannot be restored over newer text. */
export async function persistDictationComposerDraft(
  ownerId: string,
  contextKey: string,
  value: string,
  options?: DictationDbOptions,
): Promise<boolean> {
  const store = options?.purgeFenceStore ?? browserFenceStore();
  if (currentDictationPurgeFence(store)) return false;
  await importLegacyComposerDrafts(ownerId, options);
  const epoch = currentDictationCustodyEpoch(store);
  const key = composerDraftKey(ownerId, epoch, contextKey);
  return withDatabase(options, async (database) => {
    const transaction = database.transaction(COMPOSER_DRAFTS, "readwrite");
    const drafts = transaction.objectStore(COMPOSER_DRAFTS);
    if (currentDictationPurgeFence(store) || currentDictationCustodyEpoch(store) !== epoch) {
      transaction.abort();
      return false;
    }
    const prior = await requestResult(drafts.get(key) as IDBRequest<DictationComposerDraftRecord | undefined>);
    if (currentDictationPurgeFence(store) || currentDictationCustodyEpoch(store) !== epoch) {
      transaction.abort();
      return false;
    }
    drafts.put({
      key, ownerId, custodyEpoch: epoch, contextKey, value,
      deliveryIds: prior?.deliveryIds.slice(-31) ?? [], updatedAt: Date.now(),
    } satisfies DictationComposerDraftRecord);
    await transactionDone(transaction);
    return true;
  });
}

/**
 * Transactionally append a transcript and bind its durable delivery id.
 * IndexedDB serializes sibling-tab writers; replays return the already-
 * composed value without appending twice. A failed write leaves audio custody.
 */
export async function commitDictationTranscriptToComposer(
  ownerId: string,
  contextKey: string,
  deliveryId: string,
  transcript: string,
  options?: DictationDbOptions,
): Promise<string | null> {
  const store = options?.purgeFenceStore ?? browserFenceStore();
  if (currentDictationPurgeFence(store)) return null;
  await importLegacyComposerDrafts(ownerId, options);
  const epoch = currentDictationCustodyEpoch(store);
  const key = composerDraftKey(ownerId, epoch, contextKey);
  return withDatabase(options, async (database) => {
    const transaction = database.transaction(COMPOSER_DRAFTS, "readwrite");
    const drafts = transaction.objectStore(COMPOSER_DRAFTS);
    if (currentDictationPurgeFence(store) || currentDictationCustodyEpoch(store) !== epoch) {
      transaction.abort();
      return null;
    }
    const prior = await requestResult(drafts.get(key) as IDBRequest<DictationComposerDraftRecord | undefined>);
    if (currentDictationPurgeFence(store) || currentDictationCustodyEpoch(store) !== epoch) {
      transaction.abort();
      return null;
    }
    if (prior?.deliveryIds.includes(deliveryId)) {
      await transactionDone(transaction);
      return prior.value;
    }
    const clean = transcript.trim();
    const value = !clean ? (prior?.value ?? "") : !prior?.value.trim()
      ? clean
      : `${prior.value}${/\s$/.test(prior.value) ? "" : " "}${clean}`;
    drafts.put({
      key, ownerId, custodyEpoch: epoch, contextKey, value,
      deliveryIds: [...(prior?.deliveryIds ?? []).slice(-31), deliveryId], updatedAt: Date.now(),
    } satisfies DictationComposerDraftRecord);
    await transactionDone(transaction);
    return value;
  });
}

export async function clearDictationComposerDraft(
  ownerId: string,
  contextKey: string,
  options?: DictationDbOptions,
  expectedEpoch?: string,
): Promise<void> {
  const store = options?.purgeFenceStore ?? browserFenceStore();
  await importLegacyComposerDrafts(ownerId, options);
  const epoch = expectedEpoch ?? currentDictationCustodyEpoch(store);
  const key = composerDraftKey(ownerId, epoch, contextKey);
  await withDatabase(options, async (database) => {
    const transaction = database.transaction(COMPOSER_DRAFTS, "readwrite");
    if (currentDictationCustodyEpoch(store) !== epoch || currentDictationPurgeFence(store)) {
      transaction.abort();
      return;
    }
    transaction.objectStore(COMPOSER_DRAFTS).delete(key);
    await transactionDone(transaction);
  });
}

export function purgeDictationComposerDrafts(store = browserFenceStore()): void {
  try { store?.removeItem(DICTATION_COMPOSER_DRAFTS_STORAGE_COORDINATE); } catch { /* durable fence remains fail-closed */ }
}

export function clearDictationPurgeFence(epoch: string, store = browserFenceStore()): void {
  if (currentDictationPurgeFence(store) !== epoch) return;
  memoryPurgeFence = null;
  memoryPurgeFallback = false;
  try { store?.removeItem(DICTATION_PURGE_FENCE_STORAGE_COORDINATE); }
  catch { memoryPurgeFence = epoch; memoryPurgeFallback = true; }
}

/** Authenticated recovery's second clear; the only path that removes a fence. */
export async function resolveDictationPurgeFenceAfterRecovery(
  purge: () => Promise<void>,
  store = browserFenceStore(),
): Promise<boolean> {
  const fence = currentDictationPurgeFence(store);
  if (!fence) return false;
  try {
    await purge();
    clearDictationPurgeFence(fence, store);
  } catch {
    // Fail closed: later authenticated recovery will retry the same fence.
  }
  return true;
}

export function subscribeDictationPurgeFence(listener: () => void): () => void {
  const storage = (event: Event) => {
    const value = event as StorageEvent;
    if (value.key === DICTATION_PURGE_FENCE_STORAGE_COORDINATE && value.newValue) listener();
  };
  const local = () => listener();
  globalThis.addEventListener?.("storage", storage);
  globalThis.addEventListener?.(DICTATION_PURGE_EVENT, local);
  return () => {
    globalThis.removeEventListener?.("storage", storage);
    globalThis.removeEventListener?.(DICTATION_PURGE_EVENT, local);
  };
}

export function partitionDictationDrafts(
  drafts: DictationDraftRecord[],
  ownerId: string,
  now = Date.now(),
  custodyEpoch = currentDictationCustodyEpoch(),
): { admitted: DictationDraftRecord[]; purgeIds: string[] } {
  const admitted: DictationDraftRecord[] = [];
  const purgeIds: string[] = [];
  for (const draft of drafts) {
    const stale = now - draft.updatedAt > DICTATION_DRAFT_TTL_MS;
    if (!draft.ownerId || !Number.isSafeInteger(draft.generation) || draft.generation < 1 ||
      draft.custodyEpoch !== custodyEpoch || draft.ownerId !== ownerId || stale) purgeIds.push(draft.id);
    else admitted.push(draft);
  }
  return {
    admitted: admitted.sort((a, b) => b.updatedAt - a.updatedAt),
    purgeIds,
  };
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), {
      once: true,
    });
    request.addEventListener(
      "error",
      () => reject(request.error ?? new Error("IndexedDB request failed")),
      { once: true },
    );
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener(
      "abort",
      () => reject(transaction.error ?? new Error("IndexedDB transaction aborted")),
      { once: true },
    );
    transaction.addEventListener(
      "error",
      () => reject(transaction.error ?? new Error("IndexedDB transaction failed")),
      { once: true },
    );
  });
}

function factory(options?: DictationDbOptions): IDBFactory {
  const value = options?.indexedDB ?? globalThis.indexedDB;
  if (!value) throw new Error("Durable dictation storage is unavailable in this browser.");
  return value;
}

async function openDatabase(options?: DictationDbOptions): Promise<IDBDatabase> {
  const request = factory(options).open(DICTATION_DB_NAME, DICTATION_DB_VERSION);
  request.addEventListener("upgradeneeded", () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(DRAFTS)) {
      db.createObjectStore(DRAFTS, { keyPath: "id" });
    }
    if (!db.objectStoreNames.contains(CHUNKS)) {
      const chunks = db.createObjectStore(CHUNKS, {
        keyPath: ["draftId", "index"],
      });
      chunks.createIndex("by-draft", "draftId", { unique: false });
    }
    if (!db.objectStoreNames.contains(COMPOSER_DRAFTS)) {
      db.createObjectStore(COMPOSER_DRAFTS, { keyPath: "key" });
    }
  });
  return requestResult(request);
}

async function withDatabase<T>(
  options: DictationDbOptions | undefined,
  operation: (database: IDBDatabase) => Promise<T>,
): Promise<T> {
  const database = await openDatabase(options);
  try {
    return await operation(database);
  } finally {
    database.close();
  }
}

export class DictationDraftStore {
  constructor(private readonly options?: DictationDbOptions) {}

  async putDraft(draft: DictationDraftRecord): Promise<void> {
    if (currentDictationPurgeFence(this.options?.purgeFenceStore)) throw new Error("Dictation custody is being cleared for sign-out.");
    if (draft.custodyEpoch !== currentDictationCustodyEpoch(this.options?.purgeFenceStore)) throw new Error("Dictation belongs to an expired sign-in epoch.");
    await withDatabase(this.options, async (database) => {
      const transaction = database.transaction(DRAFTS, "readwrite");
      if (currentDictationPurgeFence(this.options?.purgeFenceStore) ||
        draft.custodyEpoch !== currentDictationCustodyEpoch(this.options?.purgeFenceStore)) {
        transaction.abort();
        throw new Error("Dictation sign-in epoch changed before the write committed.");
      }
      transaction.objectStore(DRAFTS).put(draft);
      await transactionDone(transaction);
    });
  }

  /** Atomically supersede every older SPA instance before recovery begins. */
  async claimDraft(draft: DictationDraftRecord): Promise<DictationDraftRecord> {
    if (currentDictationPurgeFence(this.options?.purgeFenceStore)) throw new Error("Dictation custody is being cleared for sign-out.");
    return withDatabase(this.options, async (database) => {
      const transaction = database.transaction(DRAFTS, "readwrite");
      const store = transaction.objectStore(DRAFTS);
      const current = await requestResult(store.get(draft.id) as IDBRequest<DictationDraftRecord | undefined>);
      if (!current || current.generation !== draft.generation || current.ownerId !== draft.ownerId ||
        current.custodyEpoch !== draft.custodyEpoch ||
        current.custodyEpoch !== currentDictationCustodyEpoch(this.options?.purgeFenceStore) ||
        currentDictationPurgeFence(this.options?.purgeFenceStore)) {
        transaction.abort();
        throw new DictationDraftSupersededError();
      }
      const claimed = { ...current, generation: current.generation + 1, updatedAt: Date.now() };
      store.put(claimed);
      await transactionDone(transaction);
      return claimed;
    });
  }

  /** Commit the chunk and its incremented draft cursor atomically. */
  async appendChunk(
    draft: DictationDraftRecord,
    audio: Blob,
    durationMs: number,
  ): Promise<DictationDraftRecord> {
    if (currentDictationPurgeFence(this.options?.purgeFenceStore)) throw new Error("Dictation custody is being cleared for sign-out.");
    if (draft.custodyEpoch !== currentDictationCustodyEpoch(this.options?.purgeFenceStore)) throw new Error("Dictation belongs to an expired sign-in epoch.");
    if (audio.size <= 0) return draft;
    const next: DictationDraftRecord = {
      ...draft,
      durationMs,
      nextChunkIndex: draft.nextChunkIndex + 1,
      updatedAt: Date.now(),
    };
    const chunk: DictationChunkRecord = {
      draftId: draft.id,
      index: draft.nextChunkIndex,
      bytes: audio.size,
      audio,
    };
    await withDatabase(this.options, async (database) => {
      const transaction = database.transaction([DRAFTS, CHUNKS], "readwrite");
      if (currentDictationPurgeFence(this.options?.purgeFenceStore) ||
        draft.custodyEpoch !== currentDictationCustodyEpoch(this.options?.purgeFenceStore)) {
        transaction.abort();
        throw new Error("Dictation sign-in epoch changed before the write committed.");
      }
      const current = await requestResult(
        transaction.objectStore(DRAFTS).get(draft.id) as IDBRequest<DictationDraftRecord | undefined>,
      );
      if (!current || current.generation !== draft.generation) {
        transaction.abort();
        throw new DictationDraftSupersededError();
      }
      transaction.objectStore(CHUNKS).put(chunk);
      transaction.objectStore(DRAFTS).put(next);
      await transactionDone(transaction);
    });
    return next;
  }

  async updatePhase(
    draft: DictationDraftRecord,
    phase: DictationDraftPhase,
  ): Promise<DictationDraftRecord> {
    return this.compareAndPut(draft, { ...draft, phase, updatedAt: Date.now() });
  }

  async complete(
    draft: DictationDraftRecord,
    transcript: string,
  ): Promise<DictationDraftRecord> {
    const next: DictationDraftRecord = {
      ...draft,
      phase: "complete",
      transcript,
      updatedAt: Date.now(),
    };
    return this.compareAndPut(draft, next);
  }

  private async compareAndPut(
    expected: DictationDraftRecord,
    next: DictationDraftRecord,
  ): Promise<DictationDraftRecord> {
    if (currentDictationPurgeFence(this.options?.purgeFenceStore)) throw new Error("Dictation custody is being cleared for sign-out.");
    return withDatabase(this.options, async (database) => {
      const transaction = database.transaction(DRAFTS, "readwrite");
      const store = transaction.objectStore(DRAFTS);
      const current = await requestResult(store.get(expected.id) as IDBRequest<DictationDraftRecord | undefined>);
      if (!current || current.generation !== expected.generation ||
        current.custodyEpoch !== expected.custodyEpoch ||
        current.custodyEpoch !== currentDictationCustodyEpoch(this.options?.purgeFenceStore) ||
        currentDictationPurgeFence(this.options?.purgeFenceStore)) {
        transaction.abort();
        throw new DictationDraftSupersededError();
      }
      store.put(next);
      await transactionDone(transaction);
      return next;
    });
  }

  async pendingChunks(draftId: string): Promise<DictationChunkRecord[]> {
    return withDatabase(this.options, async (database) => {
      const transaction = database.transaction(CHUNKS, "readonly");
      const index = transaction.objectStore(CHUNKS).index("by-draft");
      const chunks = await requestResult(index.getAll(draftId));
      await transactionDone(transaction);
      return chunks.sort((a, b) => a.index - b.index);
    });
  }

  async acknowledge(draftId: string, throughIndex: number): Promise<void> {
    const pending = await this.pendingChunks(draftId);
    const acknowledged = pending.filter((chunk) => chunk.index <= throughIndex);
    if (acknowledged.length === 0) return;
    await withDatabase(this.options, async (database) => {
      const transaction = database.transaction(CHUNKS, "readwrite");
      const store = transaction.objectStore(CHUNKS);
      for (const chunk of acknowledged) store.delete([chunk.draftId, chunk.index]);
      await transactionDone(transaction);
    });
  }

  async recoverableDrafts(
    ownerId: string,
    now = Date.now(),
  ): Promise<DictationDraftRecord[]> {
    const fence = currentDictationPurgeFence(this.options?.purgeFenceStore);
    if (fence) {
      await resolveDictationPurgeFenceAfterRecovery(
        async () => {
          await this.purgeAll();
          purgeDictationComposerDrafts(this.options?.purgeFenceStore);
        },
        this.options?.purgeFenceStore,
      );
      return [];
    }
    const drafts = await withDatabase(this.options, async (database) => {
      const transaction = database.transaction(DRAFTS, "readonly");
      const values = await requestResult(
        transaction.objectStore(DRAFTS).getAll() as IDBRequest<DictationDraftRecord[]>,
      );
      await transactionDone(transaction);
      return values;
    });
    const partition = partitionDictationDrafts(
      drafts,
      ownerId,
      now,
      currentDictationCustodyEpoch(this.options?.purgeFenceStore),
    );
    // Version-1 drafts have no owner and are deliberately unreadable. An
    // account switch purges the prior account's private browser custody.
    for (const id of partition.purgeIds) await this.deleteDraftById(id);
    return partition.admitted;
  }

  async purgeAll(): Promise<void> {
    // One atomic clear is both quicker and safer at the sign-out boundary than
    // enumerating drafts and reopening the database for every chunk set.
    await withDatabase(this.options, async (database) => {
      const transaction = database.transaction([DRAFTS, CHUNKS, COMPOSER_DRAFTS], "readwrite");
      transaction.objectStore(DRAFTS).clear();
      transaction.objectStore(CHUNKS).clear();
      transaction.objectStore(COMPOSER_DRAFTS).clear();
      await transactionDone(transaction);
    });
  }

  /** CAS consume/cancel: an older view may never delete a newer view's lease. */
  async deleteDraft(draft: DictationDraftRecord): Promise<boolean> {
    return this.deleteDraftById(draft.id, draft.generation);
  }

  private async deleteDraftById(draftId: string, generation?: number): Promise<boolean> {
    return withDatabase(this.options, async (database) => {
      const transaction = database.transaction([DRAFTS, CHUNKS], "readwrite");
      const drafts = transaction.objectStore(DRAFTS);
      const current = await requestResult(drafts.get(draftId) as IDBRequest<DictationDraftRecord | undefined>);
      if (!current) {
        await transactionDone(transaction);
        return false;
      }
      if (generation !== undefined && current.generation !== generation) {
        transaction.abort();
        throw new DictationDraftSupersededError();
      }
      drafts.delete(draftId);
      const chunks = transaction.objectStore(CHUNKS);
      const keys = await requestResult(chunks.index("by-draft").getAllKeys(IDBKeyRange.only(draftId)));
      for (const key of keys) chunks.delete(key);
      await transactionDone(transaction);
      return true;
    });
  }
}

/** Sign-out privacy boundary: no transient microphone bytes cross accounts. */
export async function purgeAllDictationDrafts(): Promise<void> {
  if (!globalThis.indexedDB) return;
  await new DictationDraftStore().purgeAll();
}

export const DICTATION_SIGN_OUT_PURGE_DEADLINE_MS = 500;

/**
 * Give the atomic privacy purge a bounded opportunity to commit before auth
 * navigation tears down this document. A broken IndexedDB implementation must
 * never trap the user in an authenticated session; the underlying purge keeps
 * its rejection handler even when the deadline wins.
 */
export async function purgeDictationDraftsBeforeSignOut(
  purge: () => Promise<void> = purgeAllDictationDrafts,
  deadlineMs = DICTATION_SIGN_OUT_PURGE_DEADLINE_MS,
  fenceStore = browserFenceStore(),
): Promise<"purged" | "failed" | "timed_out"> {
  beginDictationPurgeFence(fenceStore);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guardedPurge = Promise.resolve()
    .then(purge)
    // Keep the durable tombstone through the authentication transition even
    // after this first clear succeeds. The next authenticated recovery runs a
    // second atomic clear, catching any pre-fence writer that was already in
    // flight, and only then removes this exact epoch.
    .then(() => "purged" as const, () => "failed" as const);
  const deadline = new Promise<"timed_out">((resolve) => {
    timer = setTimeout(() => resolve("timed_out"), deadlineMs);
  });
  const result = await Promise.race([guardedPurge, deadline]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
}
