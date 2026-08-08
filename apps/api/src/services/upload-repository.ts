import { randomUUID } from 'node:crypto';

export type UploadPurpose =
  | 'chat'
  | 'training-set'
  | 'skill-asset'
  | 'voice-clip'
  | 'concept-reference'
  | 'generated'
  | 'account-export';
export type UploadSessionState = 'initiated' | 'uploading' | 'completed' | 'aborted' | 'expired';
export type StorageObjectState =
  | 'pending'
  | 'uploaded'
  | 'verified'
  | 'available'
  | 'quarantined'
  | 'failed';

export interface UploadInspection {
  sizeBytes: number;
  checksumSha256: string;
  header: Buffer;
  /** Whole verified bytes; required while the closed-cohort scanner is buffer-backed. */
  policyBytes: Buffer;
}

export interface StoredUploadPart {
  partNumber: number;
  etag: string;
  checksumSha256: string;
  sizeBytes: number;
}

export interface StoredPartAuthorization {
  partNumber: number;
  checksumSha256: string;
  sizeBytes: number;
  expiresAt: Date;
}

export interface StoredPolicyEvent {
  id: string;
  objectId: string;
  ownerAccountId: string;
  policyCode: string;
  state: 'pending' | 'delivering' | 'delivered' | 'failed';
  attemptCount: number;
  claimToken: string | null;
}

export interface ClaimedPolicyEvent extends StoredPolicyEvent {
  state: 'delivering';
  claimToken: string;
}

export interface PolicyEventMetrics {
  pending: number;
  claimed: number;
  failed: number;
  oldestPendingAgeMs: number;
  maxAttemptCount: number;
}

export interface UploadPolicyEventStore {
  recoverExpiredPolicyEvents(input: {
    now: Date;
    limit: number;
    maxAttempts: number;
  }): Promise<{ requeued: number; failed: number }>;
  claimDuePolicyEvents(input: {
    now: Date;
    limit: number;
    leaseMs: number;
    maxAttempts: number;
  }): Promise<ClaimedPolicyEvent[]>;
  markPolicyEventDelivered(eventId: string, claimToken: string, now: Date): Promise<boolean>;
  retryPolicyEvent(input: {
    eventId: string;
    claimToken: string;
    now: Date;
    retryDelayMs: number;
    maxAttempts: number;
    errorCode: string;
  }): Promise<'pending' | 'failed' | 'stale'>;
  policyEventMetrics(now: Date): Promise<PolicyEventMetrics>;
}

export interface StoredUpload {
  id: string;
  objectId: string;
  ownerAccountId: string;
  purpose: UploadPurpose;
  displayName: string;
  declaredSizeBytes: number;
  declaredMime: string;
  declaredSha256: string;
  partSizeBytes: number;
  backendUploadId: string;
  backingKey: string;
  backingStore: 'local' | 'r2';
  expiresAt: Date;
  capabilityExpiresAt: Date;
  state: UploadSessionState;
  objectState: StorageObjectState;
  verifiedSizeBytes: number | null;
  verifiedMime: string | null;
  verifiedSha256: string | null;
  quarantineReason: string | null;
  parts: StoredUploadPart[];
}

export interface CreateUploadRecord extends Omit<StoredUpload, 'state' | 'objectState' | 'verifiedSizeBytes' | 'verifiedMime' | 'verifiedSha256' | 'quarantineReason' | 'parts'> {}

export interface UploadRepository {
  create(input: CreateUploadRecord): Promise<StoredUpload>;
  findOwned(uploadId: string, ownerAccountId: string): Promise<StoredUpload | null>;
  findById(uploadId: string): Promise<StoredUpload | null>;
  addPart(uploadId: string, ownerAccountId: string, part: StoredUploadPart): Promise<boolean>;
  authorizePart(
    uploadId: string,
    ownerAccountId: string,
    authorization: StoredPartAuthorization,
  ): Promise<boolean>;
  findPartAuthorization(
    uploadId: string,
    ownerAccountId: string,
    partNumber: number,
  ): Promise<StoredPartAuthorization | null>;
  markAssemblyCompleted(uploadId: string, ownerAccountId: string): Promise<boolean>;
  markAvailable(
    uploadId: string,
    ownerAccountId: string,
    verified: { sizeBytes: number; mime: string; sha256: string },
  ): Promise<StoredUpload | null>;
  quarantine(uploadId: string, ownerAccountId: string, reason: string): Promise<StoredPolicyEvent | null>;
  abort(uploadId: string, ownerAccountId: string): Promise<boolean>;
  expire(uploadId: string, ownerAccountId: string): Promise<boolean>;
}

function clone(upload: StoredUpload): StoredUpload {
  return { ...upload, parts: upload.parts.map((part) => ({ ...part })) };
}

/** Deterministic unit-test repository with the same owner-scoped behavior as Postgres. */
export class InMemoryUploadRepository implements UploadRepository, UploadPolicyEventStore {
  private readonly uploads = new Map<string, StoredUpload>();
  private readonly authorizations = new Map<string, StoredPartAuthorization>();
  readonly policyEvents = new Map<string, StoredPolicyEvent>();
  private readonly policyNextAt = new Map<string, Date>();
  private readonly policyClaimExpiresAt = new Map<string, Date>();
  private readonly policyCreatedAt = new Map<string, Date>();

  async create(input: CreateUploadRecord): Promise<StoredUpload> {
    const upload: StoredUpload = {
      ...input,
      state: 'initiated',
      objectState: 'pending',
      verifiedSizeBytes: null,
      verifiedMime: null,
      verifiedSha256: null,
      quarantineReason: null,
      parts: [],
    };
    this.uploads.set(upload.id, upload);
    return clone(upload);
  }

  async findOwned(uploadId: string, ownerAccountId: string): Promise<StoredUpload | null> {
    const row = this.uploads.get(uploadId);
    return row?.ownerAccountId === ownerAccountId ? clone(row) : null;
  }

  async findById(uploadId: string): Promise<StoredUpload | null> {
    const row = this.uploads.get(uploadId);
    return row ? clone(row) : null;
  }

  async addPart(uploadId: string, ownerAccountId: string, part: StoredUploadPart): Promise<boolean> {
    const row = this.uploads.get(uploadId);
    if (!row || row.ownerAccountId !== ownerAccountId || !['initiated', 'uploading'].includes(row.state)) return false;
    if (row.parts.some((candidate) => candidate.partNumber === part.partNumber)) return false;
    row.parts.push({ ...part });
    row.parts.sort((a, b) => a.partNumber - b.partNumber);
    row.state = 'uploading';
    return true;
  }

  async authorizePart(
    uploadId: string,
    ownerAccountId: string,
    authorization: StoredPartAuthorization,
  ): Promise<boolean> {
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.ownerAccountId !== ownerAccountId || !['initiated', 'uploading'].includes(upload.state)) return false;
    const key = `${uploadId}:${authorization.partNumber}`;
    const current = this.authorizations.get(key);
    if (
      current &&
      (current.checksumSha256 !== authorization.checksumSha256 ||
        current.sizeBytes !== authorization.sizeBytes)
    ) return false;
    this.authorizations.set(key, { ...authorization });
    return true;
  }

  async findPartAuthorization(
    uploadId: string,
    ownerAccountId: string,
    partNumber: number,
  ): Promise<StoredPartAuthorization | null> {
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.ownerAccountId !== ownerAccountId) return null;
    const row = this.authorizations.get(`${uploadId}:${partNumber}`);
    return row ? { ...row } : null;
  }

  async markAssemblyCompleted(uploadId: string, ownerAccountId: string): Promise<boolean> {
    const row = this.uploads.get(uploadId);
    if (!row || row.ownerAccountId !== ownerAccountId || !['initiated', 'uploading'].includes(row.state)) return false;
    row.state = 'completed';
    row.objectState = 'uploaded';
    return true;
  }

  async markAvailable(
    uploadId: string,
    ownerAccountId: string,
    verified: { sizeBytes: number; mime: string; sha256: string },
  ): Promise<StoredUpload | null> {
    const row = this.uploads.get(uploadId);
    if (!row || row.ownerAccountId !== ownerAccountId || row.state !== 'completed' || row.objectState !== 'uploaded') return null;
    row.objectState = 'verified';
    row.verifiedSizeBytes = verified.sizeBytes;
    row.verifiedMime = verified.mime;
    row.verifiedSha256 = verified.sha256;
    row.objectState = 'available';
    return clone(row);
  }

  async quarantine(uploadId: string, ownerAccountId: string, reason: string): Promise<StoredPolicyEvent | null> {
    const row = this.uploads.get(uploadId);
    if (!row || row.ownerAccountId !== ownerAccountId || row.objectState === 'available') return null;
    row.objectState = 'quarantined';
    row.quarantineReason = reason;
    const id = `${row.objectId}:${reason}`;
    const event = this.policyEvents.get(id) ?? {
      id,
      objectId: row.objectId,
      ownerAccountId,
      policyCode: reason,
      state: 'pending' as const,
      attemptCount: 0,
      claimToken: null,
    };
    this.policyEvents.set(id, event);
    if (!this.policyNextAt.has(id)) this.policyNextAt.set(id, new Date(0));
    if (!this.policyCreatedAt.has(id)) this.policyCreatedAt.set(id, new Date());
    return { ...event };
  }

  async recoverExpiredPolicyEvents(input: {
    now: Date;
    limit: number;
    maxAttempts: number;
  }): Promise<{ requeued: number; failed: number }> {
    let requeued = 0;
    let failedCount = 0;
    for (const [id, row] of this.policyEvents) {
      if (requeued + failedCount >= input.limit) break;
      const claimExpiry = this.policyClaimExpiresAt.get(id);
      if (row.state !== 'delivering' || !claimExpiry || claimExpiry > input.now) continue;
      const failed = row.attemptCount >= input.maxAttempts;
      this.policyEvents.set(id, {
        ...row,
        state: failed ? 'failed' : 'pending',
        claimToken: null,
      });
      this.policyClaimExpiresAt.delete(id);
      if (!failed) {
        this.policyNextAt.set(id, input.now);
        requeued += 1;
      } else failedCount += 1;
    }
    return { requeued, failed: failedCount };
  }

  async claimDuePolicyEvents(input: {
    now: Date;
    limit: number;
    leaseMs: number;
    maxAttempts: number;
  }): Promise<ClaimedPolicyEvent[]> {
    const claims: ClaimedPolicyEvent[] = [];
    for (const [id, row] of this.policyEvents) {
      if (claims.length >= input.limit) break;
      const next = this.policyNextAt.get(id);
      if (
        row.state !== 'pending' ||
        row.attemptCount >= input.maxAttempts ||
        !next ||
        next > input.now
      ) continue;
      const claim: ClaimedPolicyEvent = {
        ...row,
        state: 'delivering',
        attemptCount: row.attemptCount + 1,
        claimToken: randomUUID(),
      };
      this.policyEvents.set(id, claim);
      this.policyNextAt.delete(id);
      this.policyClaimExpiresAt.set(id, new Date(input.now.getTime() + input.leaseMs));
      claims.push({ ...claim });
    }
    return claims;
  }

  async markPolicyEventDelivered(eventId: string, claimToken: string): Promise<boolean> {
    const row = this.policyEvents.get(eventId);
    if (!row || row.state !== 'delivering' || row.claimToken !== claimToken) return false;
    this.policyEvents.set(eventId, { ...row, state: 'delivered', claimToken: null });
    this.policyClaimExpiresAt.delete(eventId);
    return true;
  }

  async retryPolicyEvent(input: {
    eventId: string;
    claimToken: string;
    now: Date;
    retryDelayMs: number;
    maxAttempts: number;
    errorCode: string;
  }): Promise<'pending' | 'failed' | 'stale'> {
    const row = this.policyEvents.get(input.eventId);
    if (!row || row.state !== 'delivering' || row.claimToken !== input.claimToken) return 'stale';
    const failed = row.attemptCount >= input.maxAttempts;
    this.policyEvents.set(input.eventId, {
      ...row,
      state: failed ? 'failed' : 'pending',
      claimToken: null,
    });
    this.policyClaimExpiresAt.delete(input.eventId);
    if (!failed) this.policyNextAt.set(input.eventId, new Date(input.now.getTime() + input.retryDelayMs));
    return failed ? 'failed' : 'pending';
  }

  async policyEventMetrics(now: Date): Promise<PolicyEventMetrics> {
    const pending = [...this.policyEvents.entries()].filter(([, row]) => row.state === 'pending');
    return {
      pending: pending.length,
      claimed: [...this.policyEvents.values()].filter((row) => row.state === 'delivering').length,
      failed: [...this.policyEvents.values()].filter((row) => row.state === 'failed').length,
      oldestPendingAgeMs: pending.length === 0
        ? 0
        : Math.max(0, ...pending.map(([id]) => now.getTime() - (this.policyCreatedAt.get(id)?.getTime() ?? now.getTime()))),
      maxAttemptCount: Math.max(
        0,
        ...[...this.policyEvents.values()]
          .filter((row) => row.state !== 'delivered')
          .map((row) => row.attemptCount),
      ),
    };
  }

  async abort(uploadId: string, ownerAccountId: string): Promise<boolean> {
    const row = this.uploads.get(uploadId);
    if (!row || row.ownerAccountId !== ownerAccountId || !['initiated', 'uploading'].includes(row.state)) return false;
    row.state = 'aborted';
    row.objectState = 'failed';
    return true;
  }

  async expire(uploadId: string, ownerAccountId: string): Promise<boolean> {
    const row = this.uploads.get(uploadId);
    if (!row || row.ownerAccountId !== ownerAccountId || !['initiated', 'uploading'].includes(row.state)) return false;
    row.state = 'expired';
    row.objectState = 'failed';
    return true;
  }
}

export function newUploadIds(): { objectId: string; uploadId: string } {
  return { objectId: randomUUID(), uploadId: randomUUID() };
}
