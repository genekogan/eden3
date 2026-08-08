import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import {
  LocalObjectBackend,
  ObjectService,
  R2ObjectBackend,
  StagingCache,
  type ObjectBackend,
} from '@eden3/core';

import { MediaObjectResolver } from './media-object-repository';
import { PostgresMediaObjectRepository } from './media-object-postgres-repository';
import { ObjectBackendUploadAdapter } from './upload-object-backend';
import { PostgresUploadMultipartCleanupStore } from './upload-multipart-cleanup-postgres';
import { UploadMultipartCleanupWorker } from './upload-multipart-cleanup';
import { PostgresUploadPolicyEventStore } from './upload-policy-events-postgres';
import { UploadPolicyEventWorker } from './upload-policy-events';
import { PostgresUploadRepository } from './upload-postgres-repository';
import { UploadService } from './upload-service';

const SHA256 = /^[a-f0-9]{64}$/;

export interface StorageRuntimeLogger {
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

export interface StorageRuntime {
  uploadService: UploadService;
  mediaResolver: MediaObjectResolver;
  policyEventWorker: UploadPolicyEventWorker;
  multipartCleanupWorker: UploadMultipartCleanupWorker;
  backend: ObjectBackend;
  objectRoot: string | null;
  cacheRoot: string;
}

export interface CreateStorageRuntimeOptions {
  mediaDir: string;
  env?: NodeJS.ProcessEnv;
  logger: StorageRuntimeLogger;
}

function integer(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function resolved(raw: string | undefined, fallback: string): string {
  return path.resolve(raw?.trim() || fallback);
}

function overlaps(left: string, right: string): boolean {
  const relative = path.relative(left, right);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertPrivateRoots(mediaDir: string, objectRoot: string, cacheRoot: string, secretFile: string): void {
  const publicRoot = path.resolve(mediaDir);
  for (const [name, candidate] of [
    ['object backend', objectRoot],
    ['object cache', cacheRoot],
    ['upload capability key', secretFile],
  ] as const) {
    if (overlaps(publicRoot, candidate) || overlaps(candidate, publicRoot)) {
      throw new Error(`${name} must be outside MEDIA_DIR`);
    }
  }
  if (overlaps(objectRoot, cacheRoot) || overlaps(cacheRoot, objectRoot)) {
    throw new Error('Object backend and cache roots must be separate');
  }
}

async function materializePrivateRoots(
  mediaDir: string,
  objectRoot: string,
  cacheRoot: string,
  secretFile: string,
): Promise<{ mediaDir: string; objectRoot: string; cacheRoot: string; secretFile: string }> {
  await Promise.all([
    mkdir(mediaDir, { recursive: true }),
    mkdir(objectRoot, { recursive: true }),
    mkdir(cacheRoot, { recursive: true }),
    mkdir(path.dirname(secretFile), { recursive: true, mode: 0o700 }),
  ]);
  const [physicalMediaDir, physicalObjectRoot, physicalCacheRoot, physicalSecretParent] =
    await Promise.all([
      realpath(mediaDir),
      realpath(objectRoot),
      realpath(cacheRoot),
      realpath(path.dirname(secretFile)),
    ]);
  const physicalSecretFile = path.join(physicalSecretParent, path.basename(secretFile));
  assertPrivateRoots(physicalMediaDir, physicalObjectRoot, physicalCacheRoot, physicalSecretFile);
  return {
    mediaDir: physicalMediaDir,
    objectRoot: physicalObjectRoot,
    cacheRoot: physicalCacheRoot,
    secretFile: physicalSecretFile,
  };
}

function decodeCapabilityKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const decoded = /^[a-f0-9]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');
  if (decoded.length !== 32) throw new Error('UPLOAD_CAPABILITY_KEY must encode exactly 32 bytes');
  return decoded;
}

async function persistentCapabilityKey(filePath: string, configured: string | undefined): Promise<Buffer> {
  if (configured?.trim()) return decodeCapabilityKey(configured);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    const handle = await open(filePath, 'wx', 0o600);
    try {
      const key = randomBytes(32);
      await handle.writeFile(key.toString('base64'), 'utf8');
      await handle.sync();
      return key;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  const file = await lstat(filePath);
  if (!file.isFile() || file.isSymbolicLink()) {
    throw new Error('UPLOAD_CAPABILITY_KEY_FILE must be a regular file');
  }
  await chmod(filePath, 0o600);
  return decodeCapabilityKey(await readFile(filePath, 'utf8'));
}

function blockedHashes(raw: string | undefined): ReadonlySet<string> {
  const hashes = (raw ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (hashes.some((value) => !SHA256.test(value))) {
    throw new Error('UPLOAD_POLICY_BLOCKED_SHA256 must contain lowercase SHA-256 values');
  }
  return new Set(hashes);
}

function r2Backend(env: NodeJS.ProcessEnv): R2ObjectBackend | null {
  const values = {
    accountId: env.R2_ACCOUNT_ID?.trim(),
    bucket: env.R2_BUCKET?.trim(),
    accessKeyId: env.R2_ACCESS_KEY_ID?.trim(),
    secretAccessKey: env.R2_SECRET_ACCESS_KEY?.trim(),
  };
  const present = Object.values(values).filter(Boolean).length;
  const selected = env.OBJECT_BACKEND?.trim().toLowerCase();
  if (selected && selected !== 'local' && selected !== 'r2') {
    throw new Error('OBJECT_BACKEND must be local or r2');
  }
  if (selected === 'local' || (selected === undefined && present === 0)) return null;
  if (present !== 4) throw new Error('R2 object storage requires account, bucket, access key id, and secret');
  if ((env.R2_JURISDICTION ?? '').trim().toLowerCase() !== 'eu') {
    throw new Error('R2_JURISDICTION=eu is required');
  }
  return new R2ObjectBackend({
    accountId: values.accountId!,
    bucket: values.bucket!,
    accessKeyId: values.accessKeyId!,
    secretAccessKey: values.secretAccessKey!,
    jurisdiction: 'eu',
  });
}

/** Build the one process-wide object/upload runtime without exposing private roots. */
export async function createStorageRuntime(options: CreateStorageRuntimeOptions): Promise<StorageRuntime> {
  const env = options.env ?? process.env;
  const roots = await materializePrivateRoots(
    path.resolve(options.mediaDir),
    resolved(env.OBJECT_LOCAL_DIR, 'var/object-store'),
    resolved(env.OBJECT_CACHE_DIR, 'var/object-cache'),
    resolved(env.UPLOAD_CAPABILITY_KEY_FILE, 'var/secrets/upload-capability.key'),
  );
  const { objectRoot, cacheRoot, secretFile } = roots;

  const backend = r2Backend(env) ?? new LocalObjectBackend({ root: objectRoot });
  const capabilityKey = await persistentCapabilityKey(secretFile, env.UPLOAD_CAPABILITY_KEY);
  const cache = new StagingCache({
    root: cacheRoot,
    maxUnpinnedBytes: integer(env.OBJECT_CACHE_MAX_BYTES, 512 * 1024 * 1024, 'OBJECT_CACHE_MAX_BYTES'),
  });
  const objectService = new ObjectService({
    backend,
    cache,
    legacyHttpsHosts: (env.OBJECT_LEGACY_HTTPS_HOSTS ?? '')
      .split(',')
      .map((host) => host.trim())
      .filter(Boolean),
  });
  const policyEventWorker = new UploadPolicyEventWorker({
    store: new PostgresUploadPolicyEventStore(),
    sink: {
      deliver: async (event) => {
        options.logger.warn(
          {
            eventId: event.eventId,
            objectId: event.objectId,
            ownerAccountId: event.ownerAccountId,
            policyCode: event.policyCode,
          },
          'upload quarantined',
        );
      },
    },
  });
  const denied = blockedHashes(env.UPLOAD_POLICY_BLOCKED_SHA256);
  const uploadBackend = new ObjectBackendUploadAdapter(backend);
  const multipartCleanupWorker = new UploadMultipartCleanupWorker({
    store: new PostgresUploadMultipartCleanupStore(),
    backend: uploadBackend,
    onError: (error, context) => {
      options.logger.error(
        { err: error, ...context },
        context.terminal
          ? 'multipart upload cleanup exhausted retries'
          : 'multipart upload cleanup attempt failed',
      );
    },
  });
  const uploadService = new UploadService({
    repository: new PostgresUploadRepository(),
    backend: uploadBackend,
    capabilityKey,
    backingStore: backend instanceof R2ObjectBackend ? 'r2' : 'local',
    policyScanner: async ({ sha256 }) => ({
      quarantineReason: denied.has(sha256) ? 'policy_hash_match' : null,
    }),
    policyEventWorker,
    securityMode: 'production',
  });
  return {
    uploadService,
    mediaResolver: new MediaObjectResolver(new PostgresMediaObjectRepository(), objectService),
    policyEventWorker,
    multipartCleanupWorker,
    backend,
    objectRoot: backend instanceof LocalObjectBackend ? objectRoot : null,
    cacheRoot,
  };
}

export function storagePolicyIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const interval = integer(env.UPLOAD_POLICY_INTERVAL_MS, 30_000, 'UPLOAD_POLICY_INTERVAL_MS');
  if (interval === 0 || interval > 2_147_483_647) {
    throw new Error('UPLOAD_POLICY_INTERVAL_MS must be an integer between 1 and 2147483647');
  }
  return interval;
}

export function storageCleanupIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const interval = integer(env.UPLOAD_CLEANUP_INTERVAL_MS, 60_000, 'UPLOAD_CLEANUP_INTERVAL_MS');
  if (interval === 0 || interval > 2_147_483_647) {
    throw new Error('UPLOAD_CLEANUP_INTERVAL_MS must be an integer between 1 and 2147483647');
  }
  return interval;
}
