export type UploadPurpose =
  | 'chat'
  | 'training-set'
  | 'skill-asset'
  | 'voice-clip'
  | 'concept-reference'
  | 'generated'
  | 'account-export';

export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

interface InitiatedUpload {
  uploadId: string;
  objectId: string;
  partSizeBytes: number;
  partCount: number;
}

interface UploadStatus {
  uploadId: string;
  objectId: string;
  state: string;
  partSizeBytes: number;
  partCount: number;
  completedParts: Array<{ partNumber: number; sizeBytes: number }>;
  nextOffset: number;
  objectUrl: string | null;
  declaredSizeBytes: number;
  declaredMime: string;
  declaredSha256: string;
}

interface SignedPart {
  url: string;
  requiredHeaders: Record<string, string>;
  expiresAt: string;
}

export interface UploadableFile extends Blob {
  name: string;
  type: string;
}

export interface UploadProgress {
  uploadId: string;
  fileName: string;
  uploadedBytes: number;
  totalBytes: number;
  completedParts: number;
  partCount: number;
}

export interface ResumableUploaderOptions {
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  refreshCredentials?: () => Promise<void>;
  maxPartAttempts?: number;
  defaultPartSizeBytes?: number;
}

export interface UploadFileOptions {
  purpose: UploadPurpose;
  /** Existing durable session to continue after reload/process loss. */
  uploadId?: string;
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function sha256(blob: Blob): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
}

export class UploadClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'UploadClientError';
  }
}

/** Framework-independent multipart client; it never serializes file bytes as base64. */
export class ResumableUploader {
  private readonly apiBaseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly refreshCredentials?: () => Promise<void>;
  private readonly maxPartAttempts: number;
  private readonly defaultPartSizeBytes: number;

  constructor(options: ResumableUploaderOptions = {}) {
    this.apiBaseUrl = (options.apiBaseUrl ?? '').replace(/\/$/, '');
    this.fetcher = options.fetch ?? fetch;
    this.refreshCredentials = options.refreshCredentials;
    this.maxPartAttempts = options.maxPartAttempts ?? 3;
    this.defaultPartSizeBytes = options.defaultPartSizeBytes ?? 8 * 1024 * 1024;
  }

  async uploadFile(file: UploadableFile, options: UploadFileOptions): Promise<{ objectId: string; url: string }> {
    if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) {
      throw new UploadClientError(413, 'upload_too_large', 'Files must be between 1 byte and 64 MiB');
    }
    const fullSha256 = await sha256(file);
    const initiated = options.uploadId
      ? null
      : await this.api<InitiatedUpload>('/uploads', {
          method: 'POST',
          body: JSON.stringify({
            displayName: file.name,
            purpose: options.purpose,
            declaredSizeBytes: file.size,
            declaredMime: file.type || 'application/octet-stream',
            declaredSha256: fullSha256,
            partSizeBytes: this.defaultPartSizeBytes,
          }),
        }, options.signal);
    const uploadId = options.uploadId ?? initiated!.uploadId;
    let status = await this.api<UploadStatus>(`/uploads/${uploadId}`, {}, options.signal);
    if (
      status.declaredSizeBytes !== file.size ||
      status.declaredSha256 !== fullSha256 ||
      status.declaredMime !== (file.type || 'application/octet-stream').toLowerCase()
    ) {
      throw new UploadClientError(409, 'resume_file_mismatch', 'Selected file does not match the durable upload session');
    }
    if (status.state === 'completed' && status.objectUrl) {
      return { objectId: status.objectId, url: status.objectUrl };
    }
    const completed = new Set(status.completedParts.map((part) => part.partNumber));
    let uploadedBytes = status.completedParts.reduce((sum, part) => sum + part.sizeBytes, 0);
    const notify = () => options.onProgress?.({
      uploadId,
      fileName: file.name,
      uploadedBytes,
      totalBytes: file.size,
      completedParts: completed.size,
      partCount: status.partCount,
    });
    notify();

    for (let partNumber = 1; partNumber <= status.partCount; partNumber += 1) {
      if (completed.has(partNumber)) continue;
      const start = (partNumber - 1) * status.partSizeBytes;
      const part = file.slice(start, Math.min(file.size, start + status.partSizeBytes));
      const partSha256 = await sha256(part);
      await this.uploadPart(uploadId, partNumber, part, file.type, partSha256, options.signal);
      completed.add(partNumber);
      uploadedBytes += part.size;
      notify();
    }

    const completion = await this.api<{
      object: { id: string; url: string };
    }>(`/uploads/${uploadId}/complete`, { method: 'POST' }, options.signal);
    return { objectId: completion.object.id, url: completion.object.url };
  }

  async uploadFiles(
    files: Iterable<UploadableFile>,
    options: Omit<UploadFileOptions, 'uploadId'>,
  ): Promise<Array<{ objectId: string; url: string }>> {
    const results: Array<{ objectId: string; url: string }> = [];
    // Bound browser memory: full-file hashing is currently buffer-backed, so
    // multi-file work is intentionally sequential under the 64 MiB API cap.
    for (const file of files) results.push(await this.uploadFile(file, options));
    return results;
  }

  private async uploadPart(
    uploadId: string,
    partNumber: number,
    part: Blob,
    mime: string,
    checksumSha256: string,
    signal?: AbortSignal,
  ): Promise<void> {
    let lastFailure: unknown;
    for (let attempt = 1; attempt <= this.maxPartAttempts; attempt += 1) {
      try {
        const signed = await this.api<SignedPart>(
          `/uploads/${uploadId}/parts/${partNumber}`,
          { method: 'POST', body: JSON.stringify({ checksumSha256 }) },
          signal,
        );
        // Browsers own Content-Length for Blob bodies and forbid setting it
        // manually. The backend signature still binds the automatically
        // emitted value; the slice length is fixed by durable session state.
        const { ['content-length']: _contentLength, ...browserSettableHeaders } = signed.requiredHeaders;
        const response = await this.fetcher(signed.url, {
          method: 'PUT',
          headers: {
            'content-type': signed.url.startsWith('/uploads/')
              ? 'application/octet-stream'
              : (mime || 'application/octet-stream'),
            ...browserSettableHeaders,
          },
          body: part,
          signal,
        });
        if (!response.ok) {
          throw new UploadClientError(response.status, 'part_put_failed', `Part PUT failed (${response.status})`);
        }
        await this.api(
          `/uploads/${uploadId}/parts/${partNumber}/complete`,
          { method: 'POST', body: JSON.stringify({ checksumSha256 }) },
          signal,
        );
        return;
      } catch (error) {
        lastFailure = error;
        if (signal?.aborted || attempt === this.maxPartAttempts) throw error;
      }
    }
    throw lastFailure;
  }

  private async api<T = unknown>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
    const request = () => this.fetcher(`${this.apiBaseUrl}${path}`, {
      ...init,
      credentials: 'include',
      headers: { 'content-type': 'application/json', ...init.headers },
      signal,
    });
    let response = await request();
    if (response.status === 401 && this.refreshCredentials) {
      await this.refreshCredentials();
      response = await request();
    }
    const body = await response.json().catch(() => ({})) as {
      error?: { code?: string; message?: string };
    };
    if (!response.ok) {
      throw new UploadClientError(
        response.status,
        body.error?.code ?? 'upload_request_failed',
        body.error?.message ?? `Upload request failed (${response.status})`,
      );
    }
    return body as T;
  }
}
