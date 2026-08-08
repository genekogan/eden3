import { createHash, timingSafeEqual } from 'node:crypto';

import { ApiError } from '../errors';
import {
  mintUploadCapability,
  verifyUploadCapability,
  type UploadCapabilityClaims,
} from './upload-capability';
import {
  newUploadIds,
  type StoredUpload,
  type StoredUploadPart,
  type UploadInspection,
  type UploadPurpose,
  type UploadRepository,
} from './upload-repository';
import { quarantineError, verifyUploadHeader } from './upload-verification';
import type { UploadPolicyEventWorker } from './upload-policy-events';

export interface UploadedPartResult {
  etag: string;
  checksumSha256: string;
  sizeBytes: number;
}

export interface BackendObservedPart {
  partNumber: number;
  etag: string;
  checksumSha256?: string;
  sizeBytes: number;
}

export interface MultipartUploadBackend {
  createMultipart(input: { key: string; mime: string }): Promise<{ backendUploadId: string }>;
  signPart(input: {
    key: string;
    backendUploadId: string;
    partNumber: number;
    sizeBytes: number;
    mime: string;
    expiresAt: Date;
    checksumSha256?: string;
  }): Promise<{ url: string; headers: Record<string, string> }>;
  putPart(input: {
    key: string;
    backendUploadId: string;
    partNumber: number;
    bytes: Buffer;
  }): Promise<UploadedPartResult>;
  completeMultipart(input: {
    key: string;
    backendUploadId: string;
    parts: StoredUploadPart[];
  }): Promise<void>;
  inspectObject(input: { key: string; maxHeaderBytes: number }): Promise<UploadInspection | null>;
  listParts(input: { key: string; backendUploadId: string }): Promise<BackendObservedPart[]>;
  abortMultipart(input: { key: string; backendUploadId: string }): Promise<void>;
}

export interface InitiateUploadInput {
  displayName: string;
  purpose: UploadPurpose;
  declaredSizeBytes: number;
  declaredMime: string;
  declaredSha256: string;
  partSizeBytes?: number;
}

export interface UploadReservation {
  uploadId: string;
  objectId: string;
  partSizeBytes: number;
  partCount: number;
  expiresAt: string;
}

export interface UploadStatus {
  uploadId: string;
  objectId: string;
  state: StoredUpload['state'];
  objectState: StoredUpload['objectState'];
  partSizeBytes: number;
  partCount: number;
  completedParts: StoredUploadPart[];
  nextOffset: number;
  objectUrl: string | null;
  declaredSizeBytes: number;
  declaredMime: string;
  declaredSha256: string;
}

export interface UploadPolicyDecision {
  quarantineReason: string | null;
}

export interface UploadCompletion {
  object: {
    id: string;
    state: 'available';
    verifiedSizeBytes: number;
    verifiedMime: string;
    verifiedSha256: string;
    url: string;
  };
}

export interface UploadServiceOptions {
  repository: UploadRepository;
  backend: MultipartUploadBackend;
  capabilityKey: Buffer;
  now?: () => Date;
  capabilityTtlSeconds?: number;
  sessionTtlSeconds?: number;
  backingStore?: 'local' | 'r2';
  policyScanner?: (input: {
    uploadId: string;
    objectId: string;
    ownerAccountId: string;
    mime: string;
    sizeBytes: number;
    sha256: string;
    header: Buffer;
    bytes: Buffer;
  }) => Promise<UploadPolicyDecision>;
  policyEventWorker?: Pick<UploadPolicyEventWorker, 'tick'>;
  securityMode?: 'production' | 'test';
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

function equalText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sha256Bytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function notFound(): ApiError {
  // Owner mismatch is deliberately indistinguishable from a random id.
  return new ApiError(404, 'upload_not_found', 'Upload not found');
}

export class UploadService {
  /** Buffer-backed core backend: intentionally capped to a safe closed-cohort ceiling. */
  static readonly MAX_OBJECT_BYTES = 64 * 1024 * 1024;
  static readonly DEFAULT_PART_BYTES = 8 * 1024 * 1024;
  static readonly MAX_PARTS = 10_000;
  static readonly MAX_HEADER_BYTES = 512 * 1024;

  private readonly repository: UploadRepository;
  private readonly backend: MultipartUploadBackend;
  private readonly capabilityKey: Buffer;
  private readonly now: () => Date;
  private readonly capabilityTtlSeconds: number;
  private readonly sessionTtlSeconds: number;
  private readonly backingStore: 'local' | 'r2';
  private readonly policyScanner?: UploadServiceOptions['policyScanner'];
  private readonly policyEventWorker?: Pick<UploadPolicyEventWorker, 'tick'>;
  private readonly completions = new Set<string>();
  private readonly partWrites = new Set<string>();

  constructor(options: UploadServiceOptions) {
    if (options.capabilityKey.length < 32) throw new Error('Upload capability key must be at least 32 bytes');
    this.repository = options.repository;
    this.backend = options.backend;
    this.capabilityKey = options.capabilityKey;
    this.now = options.now ?? (() => new Date());
    this.capabilityTtlSeconds = options.capabilityTtlSeconds ?? 5 * 60;
    this.sessionTtlSeconds = options.sessionTtlSeconds ?? 24 * 60 * 60;
    this.backingStore = options.backingStore ?? 'r2';
    this.policyScanner = options.policyScanner;
    this.policyEventWorker = options.policyEventWorker;
    if (
      (options.securityMode ?? 'production') === 'production' &&
      (!this.policyScanner || !this.policyEventWorker)
    ) {
      throw new Error('Production uploads require a policy scanner and durable policy event worker');
    }
  }

  async initiate(ownerAccountId: string, input: InitiateUploadInput): Promise<UploadReservation> {
    const declaredMime = input.declaredMime.split(';')[0]!.trim().toLowerCase();
    if (!Number.isSafeInteger(input.declaredSizeBytes) || input.declaredSizeBytes <= 0) {
      throw new ApiError(400, 'invalid_upload_size', 'Upload size must be a positive integer');
    }
    if (input.declaredSizeBytes > UploadService.MAX_OBJECT_BYTES) {
      throw new ApiError(413, 'upload_too_large', 'Upload exceeds the object size limit');
    }
    if (!SHA256_RE.test(input.declaredSha256)) {
      throw new ApiError(400, 'invalid_upload_checksum', 'Expected a lowercase hex SHA-256');
    }
    if (!MIME_RE.test(declaredMime)) {
      throw new ApiError(400, 'invalid_upload_mime', 'Expected a valid MIME type');
    }
    const displayName = input.displayName.trim();
    if (displayName.length === 0 || displayName.length > 255) {
      throw new ApiError(400, 'invalid_display_name', 'Display name must contain 1–255 characters');
    }
    const partSizeBytes = input.partSizeBytes ?? UploadService.DEFAULT_PART_BYTES;
    if (!Number.isSafeInteger(partSizeBytes) || partSizeBytes <= 0 || partSizeBytes > 128 * 1024 * 1024) {
      throw new ApiError(400, 'invalid_part_size', 'Part size is outside the permitted range');
    }
    const partCount = Math.ceil(input.declaredSizeBytes / partSizeBytes);
    if (partCount > UploadService.MAX_PARTS) {
      throw new ApiError(400, 'too_many_upload_parts', 'Upload requires too many parts');
    }

    const { objectId, uploadId } = newUploadIds();
    const backingKey = `objects/${objectId.slice(0, 2)}/${objectId}`;
    const backend = await this.backend.createMultipart({ key: backingKey, mime: declaredMime });
    const expiresAt = new Date(this.now().getTime() + this.sessionTtlSeconds * 1000);
    // This is the immutable session-level ceiling for minting short-lived part
    // capabilities, not the expiry of any one token.
    const capabilityExpiresAt = expiresAt;
    try {
      await this.repository.create({
        id: uploadId,
        objectId,
        ownerAccountId,
        purpose: input.purpose,
        displayName,
        declaredSizeBytes: input.declaredSizeBytes,
        declaredMime,
        declaredSha256: input.declaredSha256,
        partSizeBytes,
        backendUploadId: backend.backendUploadId,
        backingKey,
        backingStore: this.backingStore,
        expiresAt,
        capabilityExpiresAt,
      });
    } catch (error) {
      await this.backend.abortMultipart({ key: backingKey, backendUploadId: backend.backendUploadId }).catch(() => undefined);
      throw error;
    }
    return { uploadId, objectId, partSizeBytes, partCount, expiresAt: expiresAt.toISOString() };
  }

  async status(ownerAccountId: string, uploadId: string): Promise<UploadStatus> {
    const upload = await this.repository.findOwned(uploadId, ownerAccountId);
    if (!upload) throw notFound();
    await this.expireIfNeeded(upload);
    const current = (await this.repository.findOwned(uploadId, ownerAccountId)) ?? upload;
    const partCount = Math.ceil(current.declaredSizeBytes / current.partSizeBytes);
    let nextOffset = 0;
    for (let number = 1; number <= partCount; number += 1) {
      const part = current.parts.find((candidate) => candidate.partNumber === number);
      if (!part) break;
      nextOffset += part.sizeBytes;
    }
    return {
      uploadId: current.id,
      objectId: current.objectId,
      state: current.state,
      objectState: current.objectState,
      partSizeBytes: current.partSizeBytes,
      partCount,
      completedParts: current.parts,
      nextOffset,
      objectUrl: current.objectState === 'available' ? `/media/${current.objectId}` : null,
      declaredSizeBytes: current.declaredSizeBytes,
      declaredMime: current.declaredMime,
      declaredSha256: current.declaredSha256,
    };
  }

  async signPart(
    ownerAccountId: string,
    uploadId: string,
    partNumber: number,
    input: { checksumSha256?: string } = {},
  ): Promise<{ url: string; requiredHeaders: Record<string, string>; expiresAt: string }> {
    const upload = await this.repository.findOwned(uploadId, ownerAccountId);
    if (!upload) throw notFound();
    await this.requireLive(upload);
    if (!['initiated', 'uploading'].includes(upload.state)) throw new ApiError(409, 'upload_not_active', 'Upload is not active');
    const sizeBytes = this.expectedPartSize(upload, partNumber);
    if (upload.parts.some((part) => part.partNumber === partNumber)) {
      throw new ApiError(409, 'part_already_uploaded', 'Part was already uploaded');
    }
    if (input.checksumSha256 !== undefined && !SHA256_RE.test(input.checksumSha256)) {
      throw new ApiError(400, 'invalid_part_checksum', 'Expected a lowercase hex SHA-256');
    }
    if (input.checksumSha256 === undefined) {
      throw new ApiError(400, 'part_checksum_required', 'Part SHA-256 is required');
    }
    const expiresAt = new Date(
      Math.min(
        this.now().getTime() + this.capabilityTtlSeconds * 1000,
        upload.capabilityExpiresAt.getTime(),
      ),
    );
    const claims: UploadCapabilityClaims = {
      uploadId: upload.id,
      objectId: upload.objectId,
      ownerAccountId: upload.ownerAccountId,
      partNumber,
      declaredSizeBytes: upload.declaredSizeBytes,
      declaredMime: upload.declaredMime,
      expiresUnix: Math.floor(expiresAt.getTime() / 1000),
    };
    if (!(await this.repository.authorizePart(upload.id, ownerAccountId, {
        partNumber,
        checksumSha256: input.checksumSha256,
        sizeBytes,
        expiresAt,
      }))) {
      throw new ApiError(
        409,
        'part_authorization_conflict',
        'This part is already authorized for different bytes',
      );
    }
    const token = upload.backingStore === 'local'
      ? mintUploadCapability(this.capabilityKey, claims)
      : undefined;
    const signed = await this.backend.signPart({
      key: upload.backingKey,
      backendUploadId: upload.backendUploadId,
      partNumber,
      sizeBytes,
      mime: upload.declaredMime,
      expiresAt,
      checksumSha256: input.checksumSha256,
    });
    const url = signed.url.startsWith('local-object://') && token
      ? `/uploads/${upload.id}/parts/${partNumber}`
      : signed.url;
    return {
      url,
      requiredHeaders: {
        ...signed.headers,
        ...(token ? { 'x-eden-upload-capability': token } : {}),
      },
      expiresAt: expiresAt.toISOString(),
    };
  }

  async putLocalPart(
    token: string,
    bytes: Buffer,
    options: {
      authenticatedAccountId?: string;
      expectedUploadId?: string;
      expectedPartNumber?: number;
    } = {},
  ): Promise<UploadedPartResult> {
    const claims = verifyUploadCapability(this.capabilityKey, token, this.now());
    if (
      (options.expectedUploadId !== undefined && options.expectedUploadId !== claims.uploadId) ||
      (options.expectedPartNumber !== undefined && options.expectedPartNumber !== claims.partNumber)
    ) {
      throw new ApiError(401, 'invalid_upload_capability', 'Invalid upload capability');
    }
    if (options.authenticatedAccountId && options.authenticatedAccountId !== claims.ownerAccountId) {
      throw notFound();
    }
    const upload = await this.repository.findById(claims.uploadId);
    if (!upload || upload.ownerAccountId !== claims.ownerAccountId || upload.objectId !== claims.objectId) {
      throw new ApiError(401, 'invalid_upload_capability', 'Invalid upload capability');
    }
    if (
      !equalText(upload.declaredMime, claims.declaredMime) ||
      upload.declaredSizeBytes !== claims.declaredSizeBytes
    ) {
      throw new ApiError(401, 'invalid_upload_capability', 'Invalid upload capability');
    }
    if (upload.backingStore !== 'local') {
      throw new ApiError(404, 'local_part_upload_unavailable', 'Local part upload is unavailable');
    }
    await this.requireLive(upload);
    if (!['initiated', 'uploading'].includes(upload.state)) throw new ApiError(409, 'upload_not_active', 'Upload is not active');
    if (upload.parts.some((part) => part.partNumber === claims.partNumber)) {
      throw new ApiError(409, 'part_already_uploaded', 'Part was already uploaded');
    }
    const expectedSize = this.expectedPartSize(upload, claims.partNumber);
    if (bytes.length !== expectedSize) {
      throw new ApiError(400, 'part_size_mismatch', `Part must contain exactly ${expectedSize} bytes`);
    }
    const authorization = await this.repository.findPartAuthorization(
      upload.id,
      upload.ownerAccountId,
      claims.partNumber,
    );
    if (
      !authorization ||
      authorization.sizeBytes !== expectedSize ||
      !equalText(authorization.checksumSha256, sha256Bytes(bytes))
    ) {
      throw new ApiError(422, 'part_authorization_mismatch', 'Part bytes do not match authorization');
    }
    const writeKey = `${upload.id}:${claims.partNumber}`;
    if (this.partWrites.has(writeKey)) {
      throw new ApiError(409, 'part_upload_in_progress', 'Part upload is already in progress');
    }
    this.partWrites.add(writeKey);
    try {
      // Re-read after acquiring the process fence; this closes the ordinary
      // replay race before any backend mutation in the local/test path.
      const fresh = await this.repository.findOwned(upload.id, upload.ownerAccountId);
      if (!fresh || fresh.parts.some((part) => part.partNumber === claims.partNumber)) {
        throw new ApiError(409, 'part_already_uploaded', 'Part was already uploaded');
      }
      const result = await this.backend.putPart({
        key: upload.backingKey,
        backendUploadId: upload.backendUploadId,
        partNumber: claims.partNumber,
        bytes,
      });
      if (result.sizeBytes !== expectedSize) {
        throw new ApiError(502, 'backend_part_size_mismatch', 'Backend reported an invalid part size');
      }
      const added = await this.repository.addPart(upload.id, upload.ownerAccountId, {
        partNumber: claims.partNumber,
        etag: result.etag,
        checksumSha256: result.checksumSha256,
        sizeBytes: result.sizeBytes,
      });
      if (!added) throw new ApiError(409, 'part_already_uploaded', 'Part was already uploaded');
      return result;
    } finally {
      this.partWrites.delete(writeKey);
    }
  }

  /**
   * Acknowledge a browser-direct backend PUT. No client ETag/size is trusted:
   * the provider's ListParts result is authoritative and its checksum must
   * match the checksum bound into the signed PUT request.
   */
  async confirmDirectPart(
    ownerAccountId: string,
    uploadId: string,
    partNumber: number,
    expectedSha256: string,
  ): Promise<StoredUploadPart> {
    if (!SHA256_RE.test(expectedSha256)) {
      throw new ApiError(400, 'invalid_part_checksum', 'Expected a lowercase hex SHA-256');
    }
    const upload = await this.repository.findOwned(uploadId, ownerAccountId);
    if (!upload) throw notFound();
    await this.requireLive(upload);
    if (!['initiated', 'uploading'].includes(upload.state)) {
      throw new ApiError(409, 'upload_not_active', 'Upload is not active');
    }
    const expectedSize = this.expectedPartSize(upload, partNumber);
    if (upload.backingStore === 'r2') {
      const authorization = await this.repository.findPartAuthorization(
        uploadId,
        ownerAccountId,
        partNumber,
      );
      if (
        !authorization ||
        authorization.sizeBytes !== expectedSize ||
        !equalText(authorization.checksumSha256, expectedSha256)
      ) {
        throw new ApiError(409, 'part_not_authorized', 'Part does not match its durable authorization');
      }
    }
    const existing = upload.parts.find((part) => part.partNumber === partNumber);
    if (existing) {
      if (equalText(existing.checksumSha256, expectedSha256)) return existing;
      throw new ApiError(409, 'part_already_uploaded', 'Part was already uploaded');
    }
    const backendParts = await this.backend.listParts({
      key: upload.backingKey,
      backendUploadId: upload.backendUploadId,
    });
    const providerPart = backendParts.find((part) => part.partNumber === partNumber);
    if (!providerPart) throw new ApiError(409, 'backend_part_missing', 'Backend has not received this part');
    if (
      providerPart.sizeBytes !== expectedSize ||
      !providerPart.checksumSha256 ||
      !equalText(providerPart.checksumSha256, expectedSha256)
    ) {
      throw new ApiError(422, 'backend_part_verification_failed', 'Backend part did not match its signed constraints');
    }
    const durable = {
      partNumber,
      etag: providerPart.etag,
      checksumSha256: providerPart.checksumSha256,
      sizeBytes: providerPart.sizeBytes,
    };
    if (!(await this.repository.addPart(uploadId, ownerAccountId, durable))) {
      const latest = await this.repository.findOwned(uploadId, ownerAccountId);
      const raced = latest?.parts.find((part) => part.partNumber === partNumber);
      if (raced && equalText(raced.checksumSha256, expectedSha256)) return raced;
      throw new ApiError(409, 'part_already_uploaded', 'Part was already uploaded');
    }
    return durable;
  }

  async complete(ownerAccountId: string, uploadId: string): Promise<UploadCompletion> {
    let upload = await this.repository.findOwned(uploadId, ownerAccountId);
    if (!upload) throw notFound();
    if (upload.objectState === 'available') return this.completion(upload);
    if (upload.objectState === 'quarantined') {
      await this.policyEventWorker?.tick();
      throw quarantineError(upload.quarantineReason ?? 'policy');
    }
    if (!['initiated', 'uploading', 'completed'].includes(upload.state)) {
      throw new ApiError(409, 'upload_not_active', 'Upload is not active');
    }
    if (upload.state !== 'completed') await this.requireLive(upload);
    if (this.completions.has(uploadId)) {
      throw new ApiError(409, 'upload_completion_in_progress', 'Upload completion is already in progress');
    }
    this.completions.add(uploadId);

    try {
      let inspection: UploadInspection | null = null;
      if (upload.state !== 'completed') {
        this.assertCompleteParts(upload);
        // Crash recovery boundary: provider completion consumes an R2 uploadId.
        // If the process died before the DB terminal write, the immutable final
        // key already exists and must be verified/promoted without replaying
        // CompleteMultipartUpload (which would return NoSuchUpload).
        inspection = await this.backend.inspectObject({
          key: upload.backingKey,
          maxHeaderBytes: UploadService.MAX_HEADER_BYTES,
        });
        if (!inspection) {
          await this.assertProviderParts(upload);
          await this.backend.completeMultipart({
            key: upload.backingKey,
            backendUploadId: upload.backendUploadId,
            parts: upload.parts,
          });
        }
        if (!(await this.repository.markAssemblyCompleted(uploadId, ownerAccountId))) {
          upload = (await this.repository.findOwned(uploadId, ownerAccountId)) ?? (() => { throw notFound(); })();
          if (upload.state !== 'completed') {
            throw new ApiError(409, 'upload_completion_in_progress', 'Upload completion changed state');
          }
        } else {
          upload = (await this.repository.findOwned(uploadId, ownerAccountId))!;
        }
      }
      inspection ??= await this.backend.inspectObject({
          key: upload.backingKey,
          maxHeaderBytes: UploadService.MAX_HEADER_BYTES,
        });
      if (!inspection) throw new Error('Completed backend object is missing');
      let reason: string | null = null;
      let verifiedMime: string | null = null;
      if (inspection.sizeBytes !== upload.declaredSizeBytes) reason = 'full_size_mismatch';
      else if (!equalText(inspection.checksumSha256, upload.declaredSha256)) reason = 'full_checksum_mismatch';
      else if (!Buffer.isBuffer(inspection.policyBytes) || inspection.policyBytes.length !== inspection.sizeBytes) {
        reason = 'full_policy_bytes_unavailable';
      } else {
        const verification = verifyUploadHeader(inspection.policyBytes, upload.declaredMime);
        reason = verification.quarantineReason;
        verifiedMime = verification.detectedMime;
      }
      if (!reason && this.policyScanner) {
        reason = (await this.policyScanner({
          uploadId,
          objectId: upload.objectId,
          ownerAccountId,
          mime: verifiedMime!,
          sizeBytes: inspection.sizeBytes,
          sha256: inspection.checksumSha256,
          header: inspection.header,
          bytes: inspection.policyBytes,
        })).quarantineReason;
      }
      if (reason) {
        await this.quarantine(upload, reason);
        throw quarantineError(reason);
      }
      const available = await this.repository.markAvailable(uploadId, ownerAccountId, {
        sizeBytes: inspection.sizeBytes,
        mime: verifiedMime!,
        sha256: inspection.checksumSha256,
      });
      if (!available) throw new Error('Upload verification state changed unexpectedly');
      return this.completion(available);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'upload_quarantined') throw error;
      // Backend failures before durable byte completion remain resumable. Once
      // assembly is terminal, verification failures fail closed to quarantine.
      const latest = await this.repository.findOwned(uploadId, ownerAccountId);
      if (latest?.state === 'completed' && latest.objectState !== 'quarantined') {
        await this.repository.quarantine(uploadId, ownerAccountId, 'backend_verification_failed');
        await this.policyEventWorker?.tick();
      }
      throw error;
    } finally {
      this.completions.delete(uploadId);
    }
  }

  async abort(ownerAccountId: string, uploadId: string): Promise<{ aborted: true }> {
    const upload = await this.repository.findOwned(uploadId, ownerAccountId);
    if (!upload) throw notFound();
    if (upload.state === 'aborted') return { aborted: true };
    if (!(await this.repository.abort(uploadId, ownerAccountId))) {
      throw new ApiError(409, 'upload_not_active', 'Upload is not active');
    }
    await this.backend.abortMultipart({ key: upload.backingKey, backendUploadId: upload.backendUploadId });
    return { aborted: true };
  }

  private expectedPartSize(upload: StoredUpload, partNumber: number): number {
    const partCount = Math.ceil(upload.declaredSizeBytes / upload.partSizeBytes);
    if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > partCount) {
      throw new ApiError(400, 'invalid_part_number', 'Part number is outside this upload');
    }
    return partNumber === partCount
      ? upload.declaredSizeBytes - upload.partSizeBytes * (partCount - 1)
      : upload.partSizeBytes;
  }

  private assertCompleteParts(upload: StoredUpload): void {
    const partCount = Math.ceil(upload.declaredSizeBytes / upload.partSizeBytes);
    if (upload.parts.length !== partCount) {
      throw new ApiError(409, 'upload_incomplete', 'Not every upload part is present');
    }
    let total = 0;
    for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
      const part = upload.parts[partNumber - 1];
      if (!part || part.partNumber !== partNumber || part.sizeBytes !== this.expectedPartSize(upload, partNumber)) {
        throw new ApiError(409, 'multipart_inconsistent', 'Upload part manifest is inconsistent');
      }
      total += part.sizeBytes;
    }
    if (total !== upload.declaredSizeBytes) {
      throw new ApiError(409, 'multipart_inconsistent', 'Upload part total is inconsistent');
    }
  }

  private async assertProviderParts(upload: StoredUpload): Promise<void> {
    const observed = await this.backend.listParts({
      key: upload.backingKey,
      backendUploadId: upload.backendUploadId,
    });
    if (observed.length !== upload.parts.length) {
      throw new ApiError(409, 'backend_part_manifest_mismatch', 'Backend part manifest changed');
    }
    for (const durable of upload.parts) {
      const authorization = await this.repository.findPartAuthorization(
        upload.id,
        upload.ownerAccountId,
        durable.partNumber,
      );
      if (
        !authorization ||
          authorization.sizeBytes !== durable.sizeBytes ||
          !equalText(authorization.checksumSha256, durable.checksumSha256)
      ) {
        throw new ApiError(409, 'part_authorization_mismatch', 'Part authorization changed');
      }
      const current = observed.find((part) => part.partNumber === durable.partNumber);
      if (
        !current ||
        current.sizeBytes !== durable.sizeBytes ||
        current.etag !== durable.etag ||
        !current.checksumSha256 ||
        !equalText(current.checksumSha256, durable.checksumSha256)
      ) {
        throw new ApiError(409, 'backend_part_manifest_mismatch', 'Backend part manifest changed');
      }
    }
  }

  private completion(upload: StoredUpload): UploadCompletion {
    if (
      upload.state !== 'completed' ||
      upload.objectState !== 'available' ||
      upload.verifiedSizeBytes === null ||
      upload.verifiedMime === null ||
      upload.verifiedSha256 === null
    ) {
      throw new Error('Completed upload is missing verified object metadata');
    }
    return {
      object: {
        id: upload.objectId,
        state: 'available',
        verifiedSizeBytes: upload.verifiedSizeBytes,
        verifiedMime: upload.verifiedMime,
        verifiedSha256: upload.verifiedSha256,
        url: `/media/${upload.objectId}`,
      },
    };
  }

  private async expireIfNeeded(upload: StoredUpload): Promise<void> {
    if (
      ['initiated', 'uploading'].includes(upload.state) &&
      upload.expiresAt.getTime() <= this.now().getTime()
    ) {
      await this.repository.expire(upload.id, upload.ownerAccountId);
      await this.backend.abortMultipart({
        key: upload.backingKey,
        backendUploadId: upload.backendUploadId,
      }).catch(() => undefined);
    }
  }

  private async requireLive(upload: StoredUpload): Promise<void> {
    await this.expireIfNeeded(upload);
    if (upload.expiresAt.getTime() <= this.now().getTime()) {
      throw new ApiError(410, 'upload_expired', 'Upload session expired');
    }
  }

  private async quarantine(upload: StoredUpload, reason: string): Promise<void> {
    await this.repository.quarantine(upload.id, upload.ownerAccountId, reason);
    await this.policyEventWorker?.tick();
  }

  get localPartUploadsEnabled(): boolean {
    return this.backingStore === 'local';
  }
}
