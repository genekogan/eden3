import { createHash } from 'node:crypto';

import type { ObjectBackend } from '@eden3/core';

import type { StoredUploadPart } from './upload-repository';
import type {
  BackendObservedPart,
  MultipartUploadBackend,
  UploadedPartResult,
} from './upload-service';

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Adapts the frozen core object backend to the upload verification boundary. */
export class ObjectBackendUploadAdapter implements MultipartUploadBackend {
  constructor(private readonly backend: ObjectBackend) {}

  async createMultipart(input: { key: string; mime: string }): Promise<{ backendUploadId: string }> {
    const created = await this.backend.createMultipart({ key: input.key, contentType: input.mime });
    return { backendUploadId: created.uploadId };
  }

  async signPart(input: {
    key: string;
    backendUploadId: string;
    partNumber: number;
    sizeBytes: number;
    expiresAt: Date;
    checksumSha256?: string;
  }): Promise<{ url: string; headers: Record<string, string> }> {
    const expiresInSeconds = Math.max(1, Math.floor((input.expiresAt.getTime() - Date.now()) / 1000));
    const signed = await this.backend.presignUploadPart({
      key: input.key,
      uploadId: input.backendUploadId,
      partNumber: input.partNumber,
      expiresInSeconds,
      sha256: input.checksumSha256,
      sizeBytes: input.sizeBytes,
    });
    return { url: signed.url, headers: { ...(signed.requiredHeaders ?? {}) } };
  }

  async putPart(input: {
    key: string;
    backendUploadId: string;
    partNumber: number;
    bytes: Buffer;
  }): Promise<UploadedPartResult> {
    const checksumSha256 = sha256(input.bytes);
    const result = await this.backend.uploadPart({
      key: input.key,
      uploadId: input.backendUploadId,
      partNumber: input.partNumber,
      body: input.bytes,
      sha256: checksumSha256,
    });
    if (result.checksumSha256 && result.checksumSha256 !== checksumSha256) {
      throw new Error('Backend part checksum disagreed with uploaded bytes');
    }
    return { ...result, checksumSha256 };
  }

  async completeMultipart(input: {
    key: string;
    backendUploadId: string;
    parts: StoredUploadPart[];
  }): Promise<void> {
    await this.backend.completeMultipart({
      key: input.key,
      uploadId: input.backendUploadId,
      parts: input.parts.map(({ partNumber, etag, checksumSha256 }) => ({
        partNumber,
        etag,
        checksumSha256,
      })),
    });
  }

  async inspectObject(input: { key: string; maxHeaderBytes: number }) {
    if (!(await this.backend.head(input.key))) return null;
    // Core get() is a backend read, not client input. Hashing the fetched full
    // body creates the verification boundary independently of declarations.
    const fetched = await this.backend.get(input.key);
    return {
      sizeBytes: fetched.body.length,
      checksumSha256: sha256(fetched.body),
      header: fetched.body.subarray(0, input.maxHeaderBytes),
      policyBytes: fetched.body,
    };
  }

  async listParts(input: { key: string; backendUploadId: string }): Promise<BackendObservedPart[]> {
    return this.backend.listParts({ key: input.key, uploadId: input.backendUploadId });
  }

  async abortMultipart(input: {
    key: string;
    backendUploadId: string;
    signal?: AbortSignal;
  }): Promise<void> {
    await this.backend.abortMultipart({
      key: input.key,
      uploadId: input.backendUploadId,
      signal: input.signal,
    });
  }
}
