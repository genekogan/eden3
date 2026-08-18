import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LocalObjectBackend,
  ObjectService,
  R2ObjectBackend,
  StagingCache,
  detectContentType,
  objectKey,
  sha256File,
  type ObjectBackend,
  type ObjectGetResult,
  type ObjectHead,
  type MultipartPart,
  type StoredObject,
} from './media-store';

const dirs: string[] = [];

async function freshDir(label = 'objects'): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `eden3-${label}-`));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const digest = (value: Buffer | string): string =>
  createHash('sha256').update(value).digest('hex');

const idA = '018f5e2d-4c3b-7a89-8def-0123456789ab';
const idB = '018f5e2d-4c3b-7a89-8def-0123456789ac';
const idC = '018f5e2d-4c3b-7a89-8def-0123456789ad';

function storedObject(
  objectId: string,
  bytes: Buffer,
  overrides: Partial<StoredObject> = {},
): StoredObject {
  return {
    objectId,
    backingKey: objectKey(objectId),
    backingStore: 'local',
    state: 'available',
    sha256: digest(bytes),
    sizeBytes: bytes.length,
    mime: 'application/octet-stream',
    ...overrides,
  };
}

class MemoryBackend implements ObjectBackend {
  readonly objects = new Map<string, Buffer>();
  readonly reads = new Map<string, number>();
  corruptReads = 0;

  async put(input: { key: string; body: Buffer | string; contentType?: string; sha256?: string }) {
    const bytes = Buffer.isBuffer(input.body) ? input.body : await readFile(input.body);
    const previous = this.objects.get(input.key);
    if (previous && !previous.equals(bytes)) throw new Error('immutable object conflict');
    this.objects.set(input.key, bytes);
    const head = await this.head(input.key);
    if (!head) throw new Error('put failed');
    return head;
  }

  async get(key: string): Promise<ObjectGetResult> {
    const body = this.objects.get(key);
    if (!body) throw new Error('not found');
    this.reads.set(key, (this.reads.get(key) ?? 0) + 1);
    if (this.corruptReads-- > 0) {
      return { head: { key, sizeBytes: 7 }, body: Buffer.from('corrupt') };
    }
    const head = await this.head(key);
    if (!head) throw new Error('not found');
    return { head, body };
  }

  async head(key: string): Promise<ObjectHead | null> {
    const body = this.objects.get(key);
    return body
      ? { key, sizeBytes: body.length, sha256: digest(body), etag: digest(body) }
      : null;
  }

  async delete(key: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.objects.delete(key);
  }

  async createMultipart(): Promise<never> {
    throw new Error('not used');
  }
  async uploadPart(): Promise<never> {
    throw new Error('not used');
  }
  async listParts(): Promise<MultipartPart[]> {
    throw new Error('not used');
  }
  async presignUploadPart(): Promise<never> {
    throw new Error('not used');
  }
  async completeMultipart(): Promise<never> {
    throw new Error('not used');
  }
  async abortMultipart(): Promise<void> {}
}

describe('LocalObjectBackend immutable identity', () => {
  it('uses opaque object ids for safe keys and never overwrites different bytes', async () => {
    const root = await freshDir();
    const backend = new LocalObjectBackend({ root });
    const key = objectKey(idA);
    expect(key).toBe(`objects/${idA.slice(0, 2)}/${idA}`);

    const first = await backend.put({ key, body: Buffer.from('first') });
    const again = await backend.put({ key, body: Buffer.from('first') });
    expect(again.sha256).toBe(first.sha256);
    await expect(backend.put({ key, body: Buffer.from('different') })).rejects.toThrow(
      /immutable/i,
    );
    expect((await backend.get(key)).body).toEqual(Buffer.from('first'));
  });

  it('rejects traversal and names instead of turning them into filesystem paths', async () => {
    const root = await freshDir();
    const backend = new LocalObjectBackend({ root });
    await expect(backend.put({ key: '../../escape', body: Buffer.from('x') })).rejects.toThrow(
      /key/i,
    );
    expect(() => objectKey('../../customer-name')).toThrow(/object id/i);
  });

  it('persists and lists multipart part checksum/size evidence before completion', async () => {
    const backend = new LocalObjectBackend({ root: await freshDir() });
    const key = objectKey(idA);
    const upload = await backend.createMultipart({ key });
    const part = await backend.uploadPart({
      ...upload,
      partNumber: 2,
      body: Buffer.from('part-two'),
      sha256: digest('part-two'),
    });
    expect(await backend.listParts(upload)).toEqual([part]);
  });

  it('deletes one exact immutable key idempotently and refuses unsafe keys', async () => {
    const backend = new LocalObjectBackend({ root: await freshDir() });
    const key = objectKey(idA);
    await backend.put({ key, body: Buffer.from('delete me') });

    await backend.delete(key);
    await expect(backend.head(key)).resolves.toBeNull();
    await expect(backend.delete(key)).resolves.toBeUndefined();
    await expect(backend.delete('../../outside')).rejects.toThrow(/key/i);
  });
});

describe('R2ObjectBackend configuration boundary', () => {
  it('fails closed without explicit EU jurisdiction and credentials', () => {
    const valid = {
      accountId: '0123456789abcdef0123456789abcdef',
      bucket: 'eden-media',
      accessKeyId: 'access-key',
      secretAccessKey: 'secret-key',
      jurisdiction: 'eu' as const,
    };
    expect(() => new R2ObjectBackend({ ...valid, jurisdiction: undefined })).toThrow(
      /jurisdiction/i,
    );
    expect(() => new R2ObjectBackend({ ...valid, accessKeyId: '' })).toThrow(/access/i);
    expect(() => new R2ObjectBackend({ ...valid, sessionToken: ' padded ' })).toThrow(/session token/i);
    expect(() => new R2ObjectBackend(valid)).not.toThrow();
  });

  it('signs temporary credential session tokens into requests and presigned URLs', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers['x-amz-security-token']).toBe('SESSION');
      expect(headers.authorization).toContain('SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token');
      return new Response(null, { status: 404 });
    });
    const backend = new R2ObjectBackend({
      accountId: '0123456789abcdef0123456789abcdef',
      bucket: 'eden-media',
      accessKeyId: 'AKID',
      secretAccessKey: 'SECRET',
      sessionToken: 'SESSION',
      jurisdiction: 'eu',
      fetch: fetchImpl as typeof fetch,
      now: () => new Date('2026-08-08T12:00:00.000Z'),
    });
    await expect(backend.head(objectKey(idA))).resolves.toBeNull();

    const signed = await backend.presignUploadPart({
      key: objectKey(idA),
      uploadId: 'upload-id',
      partNumber: 1,
      expiresInSeconds: 120,
    });
    expect(new URL(signed.url).searchParams.get('X-Amz-Security-Token')).toBe('SESSION');
  });

  it('presigns one specific multipart part with SigV4 and a bounded expiry', async () => {
    const backend = new R2ObjectBackend({
      accountId: '0123456789abcdef0123456789abcdef',
      bucket: 'eden-media',
      accessKeyId: 'AKID',
      secretAccessKey: 'SECRET',
      jurisdiction: 'eu',
      now: () => new Date('2026-08-08T12:00:00.000Z'),
    });
    const signed = await backend.presignUploadPart({
      key: objectKey(idA),
      uploadId: 'upload-id',
      partNumber: 3,
      expiresInSeconds: 120,
      sha256: digest('part bytes'),
      sizeBytes: Buffer.byteLength('part bytes'),
    });
    const url = new URL(signed.url);
    expect(url.protocol).toBe('https:');
    expect(url.searchParams.get('partNumber')).toBe('3');
    expect(url.searchParams.get('uploadId')).toBe('upload-id');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('120');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/);
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('x-amz-checksum-sha256');
    expect(signed.requiredHeaders).toEqual({
      'content-length': String(Buffer.byteLength('part bytes')),
      'x-amz-checksum-sha256': Buffer.from(digest('part bytes'), 'hex').toString('base64'),
    });
  });

  it('treats an already-absent R2 multipart upload as idempotent abort success', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(null, { status: 404 }));
    const backend = new R2ObjectBackend({
      accountId: '0123456789abcdef0123456789abcdef',
      bucket: 'eden-media',
      accessKeyId: 'AKID',
      secretAccessKey: 'SECRET',
      jurisdiction: 'eu',
      fetch: fetchImpl as typeof fetch,
      now: () => new Date('2026-08-08T12:00:00.000Z'),
    });
    await expect(backend.abortMultipart({
      key: objectKey(idA),
      uploadId: 'already-absent',
    })).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ method: 'DELETE' });
  });

  it('forwards abort cancellation to the R2 request', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }));
    const backend = new R2ObjectBackend({
      accountId: '0123456789abcdef0123456789abcdef',
      bucket: 'eden-media',
      accessKeyId: 'AKID',
      secretAccessKey: 'SECRET',
      jurisdiction: 'eu',
      fetch: fetchImpl as typeof fetch,
    });
    const controller = new AbortController();
    const aborted = backend.abortMultipart({
      key: objectKey(idA),
      uploadId: 'hung-provider-call',
      signal: controller.signal,
    });
    controller.abort(new Error('bounded abort'));
    await expect(aborted).rejects.toThrow('bounded abort');
  });

  it('deletes idempotently, refuses redirects, and forwards cancellation', async () => {
    const statuses = [204, 404];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(null, { status: statuses.shift() });
    });
    const backend = new R2ObjectBackend({
      accountId: '0123456789abcdef0123456789abcdef',
      bucket: 'eden-media',
      accessKeyId: 'AKID',
      secretAccessKey: 'SECRET',
      jurisdiction: 'eu',
      fetch: fetchImpl as typeof fetch,
      now: () => new Date('2026-08-08T12:00:00.000Z'),
    });
    const controller = new AbortController();

    await expect(backend.delete(objectKey(idA), controller.signal)).resolves.toBeUndefined();
    await expect(backend.delete(objectKey(idA), controller.signal)).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map((call) => call[1]?.method)).toEqual(['DELETE', 'DELETE']);
  });
});

describe('ObjectService hydration and local-file illusion', () => {
  it('retries corrupt hydration, verifies sha256, and atomically publishes only verified bytes', async () => {
    const cacheRoot = await freshDir('cache');
    const bytes = Buffer.from('verified artifact');
    const object = storedObject(idA, bytes);
    const backend = new MemoryBackend();
    backend.objects.set(object.backingKey, bytes);
    backend.corruptReads = 1;
    const cache = new StagingCache({ root: cacheRoot, maxUnpinnedBytes: 1024 });
    const service = new ObjectService({ backend, cache, hydrationAttempts: 2 });

    const hydrated = await service.hydrate(object);
    expect(await readFile(hydrated.localPath)).toEqual(bytes);
    expect(backend.reads.get(object.backingKey)).toBe(2);
    expect((await sha256File(hydrated.localPath)).sha256).toBe(object.sha256);
    expect(hydrated.localPath.startsWith(`${path.resolve(cacheRoot)}${path.sep}`)).toBe(true);
    expect(hydrated.localPath).not.toContain('verified artifact');
    expect((await stat(hydrated.localPath)).size).toBe(bytes.length);
    await hydrated.release();
  });

  it('never publishes bad bytes after bounded retries', async () => {
    const cacheRoot = await freshDir('cache');
    const bytes = Buffer.from('expected');
    const object = storedObject(idA, bytes);
    const backend = new MemoryBackend();
    backend.objects.set(object.backingKey, bytes);
    backend.corruptReads = 5;
    const cache = new StagingCache({ root: cacheRoot, maxUnpinnedBytes: 1024 });
    const service = new ObjectService({ backend, cache, hydrationAttempts: 2 });

    await expect(service.hydrate(object)).rejects.toThrow(/checksum/i);
    await expect(access(cache.pathFor(object.objectId))).rejects.toThrow();
  });

  it('denies hydration for every non-available lifecycle state', async () => {
    const backend = new MemoryBackend();
    const bytes = Buffer.from('bytes');
    const cache = new StagingCache({ root: await freshDir('cache'), maxUnpinnedBytes: 1024 });
    const service = new ObjectService({ backend, cache });
    for (const state of ['pending', 'uploaded', 'verified', 'quarantined', 'failed'] as const) {
      await expect(service.hydrate(storedObject(idA, bytes, { state }))).rejects.toThrow(
        /not available/i,
      );
    }
  });

  it('materializes a sandbox path from object identity and a sanitized display name', async () => {
    const sandboxRoot = await freshDir('sandbox');
    const bytes = Buffer.from('asset');
    const object = storedObject(idA, bytes);
    const backend = new MemoryBackend();
    backend.objects.set(object.backingKey, bytes);
    const service = new ObjectService({
      backend,
      cache: new StagingCache({ root: await freshDir('cache'), maxUnpinnedBytes: 1024 }),
      sandboxRoot,
    });
    const hydrated = await service.hydrate(object, { displayName: '../../customer secret.png' });
    expect(hydrated.agentPath).toBe(`/workspace/media/${idA}/customer-secret.png`);
    expect(hydrated.sandboxPath).toBe(
      path.join(sandboxRoot, 'media', idA, 'customer-secret.png'),
    );
    expect(await readFile(hydrated.sandboxPath!)).toEqual(bytes);
    expect(hydrated.sandboxPath!.startsWith(`${path.resolve(sandboxRoot)}${path.sep}`)).toBe(true);
    await hydrated.release();
  });

  it('refuses a sandbox media symlink instead of writing through it', async () => {
    const sandboxRoot = await freshDir('sandbox');
    const outside = await freshDir('outside');
    await symlink(outside, path.join(sandboxRoot, 'media'));
    const bytes = Buffer.from('asset');
    const object = storedObject(idA, bytes);
    const backend = new MemoryBackend();
    backend.objects.set(object.backingKey, bytes);
    const service = new ObjectService({
      backend,
      cache: new StagingCache({ root: await freshDir('cache'), maxUnpinnedBytes: 1024 }),
      sandboxRoot,
    });
    await expect(service.hydrate(object, { displayName: 'asset.bin' })).rejects.toThrow(/unsafe/i);
    await expect(access(path.join(outside, idA, 'asset.bin'))).rejects.toThrow();
  });

  it('deletes an exact private object from cache and backing only after its pin is released', async () => {
    const bytes = Buffer.from('private clone sample');
    const object = storedObject(idA, bytes, { mime: 'audio/wav' });
    const backend = new MemoryBackend();
    backend.objects.set(object.backingKey, bytes);
    const cache = new StagingCache({ root: await freshDir('cache'), maxUnpinnedBytes: 1024 });
    const service = new ObjectService({ backend, cache });
    const hydrated = await service.hydrate(object);

    await expect(service.deletePrivate(object)).rejects.toThrow(/pinned/i);
    expect(backend.objects.has(object.backingKey)).toBe(true);
    await hydrated.release();
    await service.deletePrivate(object);
    expect(await cache.has(object.objectId)).toBe(false);
    expect(backend.objects.has(object.backingKey)).toBe(false);
    await expect(service.deletePrivate(object)).resolves.toBeUndefined();
  });

  it('propagates an abort lease through a never-ending private backing deletion', async () => {
    const bytes = Buffer.from('private clone sample');
    const object = storedObject(idA, bytes, { mime: 'audio/wav' });
    const backend = new MemoryBackend();
    backend.objects.set(object.backingKey, bytes);
    const deleteBacking = vi.spyOn(backend, 'delete').mockImplementation(async (_key, signal) => {
      await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
    });
    const service = new ObjectService({
      backend,
      cache: new StagingCache({ root: await freshDir('cache'), maxUnpinnedBytes: 1024 }),
    });
    const controller = new AbortController();
    const deletion = service.deletePrivate(object, controller.signal);
    await vi.waitFor(() => expect(deleteBacking).toHaveBeenCalledOnce());
    controller.abort(new DOMException('lease expired', 'AbortError'));
    await expect(deletion).rejects.toMatchObject({ name: 'AbortError' });
    expect(deleteBacking.mock.calls[0]?.[1]).toBe(controller.signal);
    expect(backend.objects.has(object.backingKey)).toBe(true);
  });
});

describe('StagingCache quota, pins, and manifest prefetch', () => {
  it('evicts the least-recently-used unpinned entry while preserving pins', async () => {
    let tick = 0;
    const root = await freshDir('cache');
    const backend = new MemoryBackend();
    const cache = new StagingCache({ root, maxUnpinnedBytes: 4, now: () => ++tick });
    const service = new ObjectService({ backend, cache });
    const a = Buffer.from('aaaa');
    const b = Buffer.from('bbbb');
    const c = Buffer.from('cccc');
    for (const [id, value] of [
      [idA, a],
      [idB, b],
      [idC, c],
    ] as const) {
      backend.objects.set(objectKey(id), value);
    }

    const pinnedA = await service.hydrate(storedObject(idA, a));
    const hydratedB = await service.hydrate(storedObject(idB, b));
    await hydratedB.release();
    const hydratedC = await service.hydrate(storedObject(idC, c));
    await hydratedC.release();

    expect(await cache.has(idA)).toBe(true);
    expect(await cache.has(idB)).toBe(false);
    expect(await cache.has(idC)).toBe(true);
    await pinnedA.release();
  });

  it('prefetch waits for all objects and releases every pin acquired by a failed manifest', async () => {
    const root = await freshDir('cache');
    const backend = new MemoryBackend();
    const cache = new StagingCache({ root, maxUnpinnedBytes: 4 });
    const service = new ObjectService({ backend, cache, hydrationAttempts: 1 });
    const a = Buffer.from('aaaa');
    const missing = Buffer.from('nope');
    backend.objects.set(objectKey(idA), a);

    await expect(
      service.prefetch({
        entries: [
          { object: storedObject(idA, a), displayName: 'a.bin' },
          { object: storedObject(idB, missing), displayName: 'b.bin' },
        ],
      }),
    ).rejects.toThrow(/not found/i);

    // A failed prefetch cannot leak A's pin: C can evict it under the quota.
    const c = Buffer.from('cccc');
    backend.objects.set(objectKey(idC), c);
    const hydratedC = await service.hydrate(storedObject(idC, c));
    await hydratedC.release();
    expect(await cache.has(idA)).toBe(false);
  });

  it('rebuilds its quota index after restart and evicts cold LRU entries', async () => {
    const root = await freshDir('cache');
    const first = new StagingCache({ root, maxUnpinnedBytes: 4 });
    const backend = new MemoryBackend();
    const a = Buffer.from('aaaa');
    const c = Buffer.from('cccc');
    backend.objects.set(objectKey(idA), a);
    backend.objects.set(objectKey(idC), c);
    const firstService = new ObjectService({ backend, cache: first });
    await (await firstService.hydrate(storedObject(idA, a))).release();

    const restarted = new StagingCache({ root, maxUnpinnedBytes: 4 });
    const restartedService = new ObjectService({ backend, cache: restarted });
    await (await restartedService.hydrate(storedObject(idC, c))).release();
    expect(await restarted.has(idA)).toBe(false);
    expect(await restarted.has(idC)).toBe(true);
  });
});

describe('legacy indirection and cutover', () => {
  it('allows only configured HTTPS hosts and verifies byte-identical target backing', async () => {
    const bytes = Buffer.from('migrated bytes');
    const backend = new MemoryBackend();
    backend.objects.set(objectKey(idA), bytes);
    const fetchImpl: typeof fetch = vi.fn(async (url: string | URL | Request) => {
      expect(new URL(url instanceof Request ? url.url : url).hostname).toBe(
        'media-one.example.invalid',
      );
      return new Response(bytes, { status: 200 });
    });
    const service = new ObjectService({
      backend,
      cache: new StagingCache({ root: await freshDir('cache'), maxUnpinnedBytes: 1024 }),
      legacyHttpsHosts: ['media-one.example.invalid'],
      fetch: fetchImpl,
    });
    const legacy = storedObject(idA, bytes, {
      backingStore: 'legacy',
      legacySourceUrl: 'https://media-one.example.invalid/original.jpg',
    });

    expect(await service.verifyLegacyCutover(legacy)).toBe(true);
    await expect(
      service.hydrate({
        ...legacy,
        legacySourceUrl: 'http://media-one.example.invalid/original.jpg',
      }),
    ).rejects.toThrow(/https/i);
    await expect(
      service.hydrate({ ...legacy, legacySourceUrl: 'https://evil.example/original.jpg' }),
    ).rejects.toThrow(/allowlist/i);
  });

  it('rejects cutover when either backing differs from the verified identity', async () => {
    const original = Buffer.from('original');
    const backend = new MemoryBackend();
    backend.objects.set(objectKey(idA), Buffer.from('changed!'));
    const service = new ObjectService({
      backend,
      cache: new StagingCache({ root: await freshDir('cache'), maxUnpinnedBytes: 1024 }),
      legacyHttpsHosts: ['legacy.example'],
      fetch: async () => new Response(original, { status: 200 }),
    });
    const legacy = storedObject(idA, original, {
      backingStore: 'legacy',
      legacySourceUrl: 'https://legacy.example/file',
    });
    await expect(service.verifyLegacyCutover(legacy)).rejects.toThrow(/cutover|checksum/i);
  });
});

describe('detectContentType', () => {
  it('uses bytes rather than user filenames', () => {
    expect(detectContentType(Buffer.from('%PDF-1.7\n'))).toBe('application/pdf');
    expect(
      detectContentType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe('image/png');
    expect(detectContentType(Buffer.from('<script>alert(1)</script>'))).toBeNull();
  });
});
