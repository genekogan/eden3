import { describe, expect, it, vi } from 'vitest';

import { ResumableUploader, type UploadProgress } from '../lib/resumable-upload';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fixture(contents: string, name = 'fixture.txt') {
  const blob = new Blob([contents], { type: 'text/plain' });
  return Object.assign(blob, { name });
}

describe('ResumableUploader', () => {
  it('binds the default browser fetch to the global window authority', async () => {
    const originalFetch = globalThis.fetch;
    const fetcher = vi.fn(function (this: unknown) {
      expect(this).toBe(globalThis);
      return Promise.resolve(json({ error: { code: 'diagnostic_stop', message: 'stop' } }, 503));
    });
    globalThis.fetch = fetcher as typeof fetch;
    try {
      const uploader = new ResumableUploader({ apiBaseUrl: '/api' });
      await expect(uploader.uploadFile(fixture('abc'), { purpose: 'chat' })).rejects.toMatchObject({
        status: 503,
        code: 'diagnostic_stop',
      });
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reports a durable session before status transfer and authenticates control calls', async () => {
    const sessions: Array<{ uploadId: string; objectId: string }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      const headers = new Headers(init.headers);
      expect(headers.get('authorization')).toBe('Bearer clerk-token');
      if (url === '/api/uploads') {
        return json({ uploadId: 'session-durable', objectId: 'object-durable', partSizeBytes: 3, partCount: 1 }, 201);
      }
      if (url === '/api/uploads/session-durable') {
        return json({ error: { code: 'database_unavailable', message: 'retry' } }, 503);
      }
      throw new Error(`Unexpected ${url}`);
    });
    const uploader = new ResumableUploader({
      apiBaseUrl: '/api',
      fetch: fetcher as typeof fetch,
      getAuthToken: async () => 'clerk-token',
    });

    await expect(
      uploader.uploadFile(fixture('abc'), {
        purpose: 'chat',
        onSession: (session) => sessions.push(session),
      }),
    ).rejects.toMatchObject({ status: 503, code: 'database_unavailable' });
    expect(sessions).toEqual([{ uploadId: 'session-durable', objectId: 'object-durable' }]);
  });

  it('routes local capability PUTs through the API rewrite without leaking Clerk auth', async () => {
    const contents = 'abc';
    const sha = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    const fetcher = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? 'GET';
      const headers = new Headers(init.headers);
      if (url === '/api/uploads' && method === 'POST') {
        return json({ uploadId: 'local-1', objectId: 'object-1', partSizeBytes: 3, partCount: 1 }, 201);
      }
      if (url === '/api/uploads/local-1' && method === 'GET') {
        return json({ uploadId: 'local-1', objectId: 'object-1', state: 'initiated', partSizeBytes: 3,
          partCount: 1, completedParts: [], nextOffset: 0, objectUrl: null,
          declaredSizeBytes: 3, declaredMime: 'text/plain', declaredSha256: sha });
      }
      if (url === '/api/uploads/local-1/parts/1' && method === 'POST') {
        return json({ url: '/uploads/local-1/parts/1', requiredHeaders: {
          'x-eden-upload-capability': 'capability-only', 'content-length': '3',
        }, expiresAt: new Date().toISOString() });
      }
      if (url === '/api/uploads/local-1/parts/1' && method === 'PUT') {
        expect(headers.get('x-eden-upload-capability')).toBe('capability-only');
        expect(headers.get('authorization')).toBeNull();
        expect(headers.get('content-type')).toBe('application/octet-stream');
        return json({ partNumber: 1 }, 201);
      }
      if (url === '/api/uploads/local-1/parts/1/complete') return json({ partNumber: 1 });
      if (url === '/api/uploads/local-1/complete') {
        expect(headers.get('content-type')).toBeNull();
        expect(init.body).toBeUndefined();
        return json({ object: { id: 'object-1', url: '/media/object-1' } });
      }
      throw new Error(`Unexpected ${method} ${url}`);
    });
    const uploader = new ResumableUploader({
      apiBaseUrl: '/api', fetch: fetcher as typeof fetch, getAuthToken: async () => 'clerk-token',
    });

    await expect(uploader.uploadFile(fixture(contents), { purpose: 'chat' })).resolves.toEqual({
      objectId: 'object-1', url: '/media/object-1',
    });
  });

  it('resumes at a nonzero offset and refreshes an expired part URL without re-uploading completed parts', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    let signCount = 0;
    const fetcher = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? 'GET';
      calls.push({ url, method });
      if (url === '/uploads/session-1') {
        return json({
          uploadId: 'session-1', objectId: 'object-1', state: 'uploading',
          partSizeBytes: 3, partCount: 2,
          completedParts: [{ partNumber: 1, sizeBytes: 3 }], nextOffset: 3, objectUrl: null,
          declaredSizeBytes: 6, declaredMime: 'text/plain',
          declaredSha256: 'bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721',
        });
      }
      if (url.endsWith('/parts/2') && method === 'POST') {
        signCount += 1;
        return json({ url: `https://r2.invalid/part-2-${signCount}`, requiredHeaders: { 'x-required': 'yes' }, expiresAt: new Date().toISOString() });
      }
      if (url === 'https://r2.invalid/part-2-1') return new Response('', { status: 403 });
      if (url === 'https://r2.invalid/part-2-2') return new Response('', { status: 200 });
      if (url.endsWith('/parts/2/complete')) return json({ partNumber: 2 });
      if (url.endsWith('/complete')) return json({ object: { id: 'object-1', url: '/media/object-1' } });
      throw new Error(`Unexpected ${method} ${url}`);
    });
    const progress: UploadProgress[] = [];
    const uploader = new ResumableUploader({ fetch: fetcher as typeof fetch, maxPartAttempts: 3 });
    const result = await uploader.uploadFile(fixture('abcdef'), {
      purpose: 'chat', uploadId: 'session-1', onProgress: (value) => progress.push(value),
    });

    expect(result).toEqual({ objectId: 'object-1', url: '/media/object-1' });
    expect(signCount).toBe(2);
    expect(calls.some((call) => call.url.endsWith('/parts/1') && call.method === 'POST')).toBe(false);
    expect(progress.map((value) => value.uploadedBytes)).toEqual([3, 6]);
  });

  it('uploads multiple files independently and reports per-file progress', async () => {
    let sequence = 0;
    const sessions = new Map<string, { objectId: string; size: number }>();
    const fetcher = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? 'GET';
      if (url === '/uploads' && method === 'POST') {
        sequence += 1;
        const body = JSON.parse(String(init.body)) as { declaredSizeBytes: number };
        sessions.set(`u${sequence}`, { objectId: `o${sequence}`, size: body.declaredSizeBytes });
        return json({ uploadId: `u${sequence}`, objectId: `o${sequence}`, partSizeBytes: 1024, partCount: 1 });
      }
      const status = url.match(/^\/uploads\/(u\d+)$/);
      if (status) {
        const row = sessions.get(status[1]!)!;
        const sha = row.size === 3
          ? (status[1] === 'u1'
              ? '7692c3ad3540bb803c020b3aee66cd8887123234ea0c6e7143c0add73ff431ed'
              : '3fc4ccfe745870e2c0d99f71f30ff0656c8dedd41cc1d7d3d376b0dbe685e2f3')
          : '';
        return json({ uploadId: status[1], objectId: row.objectId, state: 'initiated', partSizeBytes: 1024, partCount: 1, completedParts: [], nextOffset: 0, objectUrl: null, declaredSizeBytes: row.size, declaredMime: 'text/plain', declaredSha256: sha });
      }
      const sign = url.match(/^\/uploads\/(u\d+)\/parts\/1$/);
      if (sign) return json({ url: `https://r2.invalid/${sign[1]}`, requiredHeaders: {}, expiresAt: new Date().toISOString() });
      if (url.startsWith('https://r2.invalid/')) return new Response('', { status: 200 });
      if (url.endsWith('/parts/1/complete')) return json({ partNumber: 1 });
      const complete = url.match(/^\/uploads\/(u\d+)\/complete$/);
      if (complete) {
        const row = sessions.get(complete[1]!)!;
        return json({ object: { id: row.objectId, url: `/media/${row.objectId}` } });
      }
      throw new Error(`Unexpected ${method} ${url}`);
    });
    const progress: string[] = [];
    const uploader = new ResumableUploader({ fetch: fetcher as typeof fetch, defaultPartSizeBytes: 1024 });
    const results = await uploader.uploadFiles([fixture('one', 'one.txt'), fixture('two', 'two.txt')], {
      purpose: 'skill-asset',
      onProgress: (value) => progress.push(`${value.fileName}:${value.uploadedBytes}`),
    });
    expect(results).toEqual([
      { objectId: 'o1', url: '/media/o1' },
      { objectId: 'o2', url: '/media/o2' },
    ]);
    expect(progress).toEqual(expect.arrayContaining(['one.txt:3', 'two.txt:3']));
  });
});
