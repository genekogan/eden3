import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createStorageRuntime } from '../src/services/storage-runtime';

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
    const logger = { warn: () => undefined };
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
    expect(first.objectRoot).toBe(objectRoot);
    expect(first.cacheRoot).toBe(cacheRoot);
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
      logger: { warn: () => undefined },
      env: { ...common, OBJECT_LOCAL_DIR: path.join(mediaDir, 'objects') },
    })).rejects.toThrow(/outside MEDIA_DIR/);
    await expect(createStorageRuntime({
      mediaDir,
      logger: { warn: () => undefined },
      env: { ...common, OBJECT_LOCAL_DIR: base },
    })).rejects.toThrow(/outside MEDIA_DIR/);
  });

  it('fails closed on partial R2 configuration instead of silently using local storage', async () => {
    const base = await root();
    await expect(createStorageRuntime({
      mediaDir: path.join(base, 'media'),
      logger: { warn: () => undefined },
      env: {
        OBJECT_BACKEND: 'r2',
        OBJECT_LOCAL_DIR: path.join(base, 'objects'),
        OBJECT_CACHE_DIR: path.join(base, 'cache'),
        UPLOAD_CAPABILITY_KEY_FILE: path.join(base, 'secret', 'key'),
        R2_ACCOUNT_ID: 'a'.repeat(32),
      },
    })).rejects.toThrow(/requires account, bucket, access key id, and secret/);
  });
});
