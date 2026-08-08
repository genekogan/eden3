import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createStorageRuntime,
  storageCleanupIntervalMs,
  storagePolicyIntervalMs,
} from '../src/services/storage-runtime';

const logger = { warn: () => undefined, error: () => undefined };

describe('storage runtime composition', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function root(): Promise<string> {
    const created = await mkdtemp(path.join(os.tmpdir(), 'eden3-storage-runtime-'));
    roots.push(created);
    return created;
  }

  it('keeps backend, cache, and persistent capability material outside public media', async () => {
    const base = await root();
    const mediaDir = path.join(base, 'public-media');
    const objectRoot = path.join(base, 'private-objects');
    const cacheRoot = path.join(base, 'private-cache');
    const keyFile = path.join(base, 'private-secrets', 'upload.key');
    const first = await createStorageRuntime({
      mediaDir,
      logger,
      env: {
        OBJECT_BACKEND: 'local',
        OBJECT_LOCAL_DIR: objectRoot,
        OBJECT_CACHE_DIR: cacheRoot,
        UPLOAD_CAPABILITY_KEY_FILE: keyFile,
      },
    });
    expect(first.objectRoot).toBe(await realpath(objectRoot));
    expect(first.multipartCleanupWorker).toBeDefined();
    expect(first.cacheRoot).toBe(await realpath(cacheRoot));
    expect(path.relative(mediaDir, objectRoot)).toMatch(/^\.\./);
    expect(path.relative(mediaDir, cacheRoot)).toMatch(/^\.\./);
    expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
    const keyBefore = await readFile(keyFile, 'utf8');
    expect(Buffer.from(keyBefore, 'base64')).toHaveLength(32);

    await createStorageRuntime({
      mediaDir,
      logger,
      env: {
        OBJECT_BACKEND: 'local',
        OBJECT_LOCAL_DIR: objectRoot,
        OBJECT_CACHE_DIR: cacheRoot,
        UPLOAD_CAPABILITY_KEY_FILE: keyFile,
      },
    });
    expect(await readFile(keyFile, 'utf8')).toBe(keyBefore);
    await expect(access(path.join(mediaDir, 'objects'))).rejects.toThrow();
  });

  it('refuses any private runtime path nested with the public media root', async () => {
    const base = await root();
    const mediaDir = path.join(base, 'media');
    const common = {
      OBJECT_BACKEND: 'local',
      OBJECT_CACHE_DIR: path.join(base, 'cache'),
      UPLOAD_CAPABILITY_KEY_FILE: path.join(base, 'secret', 'key'),
    };
    await expect(createStorageRuntime({
      mediaDir,
      logger,
      env: { ...common, OBJECT_LOCAL_DIR: path.join(mediaDir, 'objects') },
    })).rejects.toThrow(/outside MEDIA_DIR/);
    await expect(createStorageRuntime({
      mediaDir,
      logger,
      env: { ...common, OBJECT_LOCAL_DIR: base },
    })).rejects.toThrow(/outside MEDIA_DIR/);
  });

  it('fails closed on partial R2 configuration instead of silently using local storage', async () => {
    const base = await root();
    await expect(createStorageRuntime({
      mediaDir: path.join(base, 'media'),
      logger,
      env: {
        OBJECT_BACKEND: 'r2',
        OBJECT_LOCAL_DIR: path.join(base, 'objects'),
        OBJECT_CACHE_DIR: path.join(base, 'cache'),
        UPLOAD_CAPABILITY_KEY_FILE: path.join(base, 'secret', 'key'),
        R2_ACCOUNT_ID: 'a'.repeat(32),
      },
    })).rejects.toThrow(/requires account, bucket, access key id, and secret/);
  });

  it.each(['object', 'cache', 'secret'] as const)(
    'rejects a %s path whose symlink target is inside MEDIA_DIR',
    async (kind) => {
      const base = await root();
      const mediaDir = path.join(base, 'media');
      await mkdir(mediaDir);
      const alias = path.join(base, `${kind}-alias`);
      await symlink(mediaDir, alias, 'dir');
      const env = {
        OBJECT_BACKEND: 'local',
        OBJECT_LOCAL_DIR: kind === 'object' ? alias : path.join(base, 'objects'),
        OBJECT_CACHE_DIR: kind === 'cache' ? alias : path.join(base, 'cache'),
        UPLOAD_CAPABILITY_KEY_FILE:
          kind === 'secret' ? path.join(alias, 'capability.key') : path.join(base, 'secret', 'key'),
      };
      await expect(createStorageRuntime({
        mediaDir,
        logger,
        env,
      })).rejects.toThrow(/outside MEDIA_DIR/);
      await expect(access(path.join(mediaDir, 'capability.key'))).rejects.toThrow();
    },
  );

  it('refuses to disable the mandatory production policy worker interval', () => {
    expect(() => storagePolicyIntervalMs({ UPLOAD_POLICY_INTERVAL_MS: '0' })).toThrow(
      /positive integer/,
    );
  });

  it('refuses to disable the durable multipart cleanup interval', () => {
    expect(() => storageCleanupIntervalMs({ UPLOAD_CLEANUP_INTERVAL_MS: '0' })).toThrow(
      /positive integer/,
    );
    expect(storageCleanupIntervalMs({ UPLOAD_CLEANUP_INTERVAL_MS: '15000' })).toBe(15_000);
  });
});
