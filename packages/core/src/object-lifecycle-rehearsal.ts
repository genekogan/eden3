import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  ObjectService,
  StagingCache,
  objectKey,
  type ObjectBackend,
  type StoredObject,
} from './media-store';

export const OBJECT_LIFECYCLE_REHEARSAL_SCHEMA = 'eden3.r2-object-lifecycle@v1' as const;

export interface ObjectLifecycleRehearsalOptions {
  /** Write/delete authority. It is deliberately distinct from the read authority. */
  writer: Pick<ObjectBackend, 'put' | 'delete'>;
  /** Read-only credentials in a live run; mutation methods are never called. */
  reader: ObjectBackend;
  cacheRoot: string;
  sandboxRoot: string;
  objectId?: string;
  body?: Buffer;
  now?: () => number;
}

export interface ObjectLifecycleRehearsalReceipt {
  schemaVersion: typeof OBJECT_LIFECYCLE_REHEARSAL_SCHEMA;
  status: 'passed';
  objectIdentitySha256: string;
  contentSha256: string;
  sizeBytes: number;
  uploadMs: number;
  hydrationMs: number;
  deletionMs: number;
  terminalRemoteAbsent: true;
  terminalCacheAbsent: true;
  terminalSandboxAbsent: true;
}

export class ObjectLifecycleRehearsalError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ObjectLifecycleRehearsalError';
  }
}

type ObjectLifecyclePhase =
  | 'upload'
  | 'reader_identity'
  | 'hydration'
  | 'hydration_identity'
  | 'deletion'
  | 'remote_absence';

function safeLifecycleError(error: unknown, phase: ObjectLifecyclePhase): unknown {
  if (error instanceof ObjectLifecycleRehearsalError) return error;
  if (error instanceof Error && /^R2 (PUT|GET|HEAD|DELETE) failed with status [1-5][0-9]{2}$/.test(error.message)) {
    return error;
  }
  return new ObjectLifecycleRehearsalError(`r2_object_${phase}_failed`);
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function isAbsent(target: string): Promise<boolean> {
  try {
    await stat(target);
    return false;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
  }
}

/**
 * Exercise the production object-service seam with split credentials.
 * Every remote and local artifact is removed before a passing receipt exists.
 */
export async function runObjectLifecycleRehearsal(
  options: ObjectLifecycleRehearsalOptions,
): Promise<ObjectLifecycleRehearsalReceipt> {
  const objectId = options.objectId ?? randomUUID();
  const key = objectKey(objectId);
  const body = options.body ?? Buffer.from(`eden3-r2-object-lifecycle-v1:${objectId}`, 'utf8');
  const contentSha256 = sha256(body);
  const cache = new StagingCache({
    root: options.cacheRoot,
    maxUnpinnedBytes: Math.max(1_048_576, body.length * 2),
  });
  const service = new ObjectService({
    backend: options.reader,
    cache,
    sandboxRoot: options.sandboxRoot,
    hydrationAttempts: 2,
  });
  const descriptor: StoredObject = {
    objectId,
    backingKey: key,
    backingStore: 'r2',
    state: 'available',
    sha256: contentSha256,
    sizeBytes: body.length,
    mime: 'application/octet-stream',
  };
  const cachePath = cache.pathFor(objectId);
  const sandboxDirectory = path.join(path.resolve(options.sandboxRoot), 'media', objectId);
  const now = options.now ?? Date.now;
  let objectMayExist = false;
  let hydrated: Awaited<ReturnType<ObjectService['hydrate']>> | undefined;
  let primaryError: unknown;
  let uploadMs = 0;
  let hydrationMs = 0;
  let deletionMs = 0;
  let phase: ObjectLifecyclePhase = 'upload';

  try {
    const uploadStarted = now();
    objectMayExist = true;
    const put = await options.writer.put({
      key,
      body,
      contentType: descriptor.mime,
      sha256: contentSha256,
    });
    uploadMs = now() - uploadStarted;
    if (put.sha256 !== contentSha256 || put.sizeBytes !== body.length) {
      throw new ObjectLifecycleRehearsalError('r2_object_upload_identity_mismatch');
    }

    phase = 'reader_identity';
    const observed = await options.reader.head(key);
    if (!observed || observed.sha256 !== contentSha256 || observed.sizeBytes !== body.length) {
      throw new ObjectLifecycleRehearsalError('r2_object_reader_identity_mismatch');
    }

    phase = 'hydration';
    const hydrationStarted = now();
    hydrated = await service.hydrate(descriptor, { displayName: 'rehearsal.bin' });
    hydrationMs = now() - hydrationStarted;
    if (!hydrated.sandboxPath) {
      throw new ObjectLifecycleRehearsalError('r2_object_sandbox_projection_missing');
    }
    phase = 'hydration_identity';
    const [cached, sandboxed] = await Promise.all([
      readFile(hydrated.localPath),
      readFile(hydrated.sandboxPath),
    ]);
    if (!cached.equals(body) || !sandboxed.equals(body)) {
      throw new ObjectLifecycleRehearsalError('r2_object_hydration_identity_mismatch');
    }
    await hydrated.release();
    hydrated = undefined;

    phase = 'deletion';
    const deletionStarted = now();
    await options.writer.delete(key);
    phase = 'remote_absence';
    if (await options.reader.head(key)) {
      throw new ObjectLifecycleRehearsalError('r2_object_remote_absence_unproven');
    }
    objectMayExist = false;
    deletionMs = now() - deletionStarted;
  } catch (error) {
    primaryError = safeLifecycleError(error, phase);
  } finally {
    await hydrated?.release().catch(() => {});
    await Promise.all([
      rm(cachePath, { force: true }),
      rm(sandboxDirectory, { recursive: true, force: true }),
    ]).catch(() => {
      primaryError = new ObjectLifecycleRehearsalError('r2_object_local_cleanup_failed');
    });
    if (objectMayExist) {
      try {
        await options.writer.delete(key);
        if (await options.reader.head(key)) {
          throw new Error('remote object remains');
        }
        objectMayExist = false;
      } catch {
        primaryError = new ObjectLifecycleRehearsalError('r2_object_cleanup_failed');
      }
    }
  }

  if (primaryError) throw primaryError;
  if (!(await isAbsent(cachePath)) || !(await isAbsent(sandboxDirectory))) {
    throw new ObjectLifecycleRehearsalError('r2_object_local_absence_unproven');
  }
  return Object.freeze({
    schemaVersion: OBJECT_LIFECYCLE_REHEARSAL_SCHEMA,
    status: 'passed',
    objectIdentitySha256: sha256(objectId),
    contentSha256,
    sizeBytes: body.length,
    uploadMs,
    hydrationMs,
    deletionMs,
    terminalRemoteAbsent: true,
    terminalCacheAbsent: true,
    terminalSandboxAbsent: true,
  });
}
