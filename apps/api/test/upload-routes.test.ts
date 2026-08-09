import { createHash } from 'node:crypto';

import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { uploadsRoutes } from '../src/routes/uploads';
import { InMemoryUploadRepository, type UploadInspection } from '../src/services/upload-repository';
import { UploadService, type MultipartUploadBackend } from '../src/services/upload-service';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

class RouteBackend implements MultipartUploadBackend {
  parts = new Map<string, Map<number, Buffer>>();
  objects = new Map<string, Buffer>();
  async createMultipart(input: { key: string }) {
    this.parts.set(input.key, new Map());
    return { backendUploadId: input.key };
  }
  async signPart(input: { key: string; partNumber: number }) {
    return { url: `/uploads/direct/${input.partNumber}`, headers: {} };
  }
  async putPart(input: { backendUploadId: string; partNumber: number; bytes: Buffer }) {
    this.parts.get(input.backendUploadId)!.set(input.partNumber, input.bytes);
    return { partNumber: input.partNumber, etag: `e${input.partNumber}`, checksumSha256: digest(input.bytes), sizeBytes: input.bytes.length };
  }
  async listParts(input: { backendUploadId: string }) {
    return [...this.parts.get(input.backendUploadId)!.entries()].map(([partNumber, bytes]) => ({
      partNumber, etag: `e${partNumber}`, checksumSha256: digest(bytes), sizeBytes: bytes.length,
    }));
  }
  async completeMultipart(input: { key: string; backendUploadId: string; parts: Array<{ partNumber: number }> }) {
    const parts = this.parts.get(input.backendUploadId)!;
    this.objects.set(input.key, Buffer.concat(input.parts.map((part) => parts.get(part.partNumber)!)));
  }
  async inspectObject(input: { key: string }): Promise<UploadInspection | null> {
    const bytes = this.objects.get(input.key);
    if (!bytes) return null;
    return { sizeBytes: bytes.length, checksumSha256: digest(bytes), header: bytes, policyBytes: bytes };
  }
  async abortMultipart() {}
}

describe('uploadsRoutes tenant boundary', () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

  it('derives ownership only from authentication and completes through the signed local PUT path', async () => {
    const app = Fastify();
    apps.push(app);
    app.decorateRequest('account', null);
    app.decorate('requireAuth', async (request, reply) => {
      const accountId = request.headers['x-test-account'];
      if (typeof accountId !== 'string') return void (await reply.code(401).send({ error: { code: 'unauthorized' } }));
      request.account = { accountId, username: accountId, isAdmin: false };
    });
    const service = new UploadService({
      repository: new InMemoryUploadRepository(),
      backend: new RouteBackend(),
      capabilityKey: Buffer.alloc(32, 9),
      backingStore: 'local',
      securityMode: 'test',
    });
    await app.register(uploadsRoutes, { service });
    const bytes = Buffer.from('benign');
    const initiated = await app.inject({
      method: 'POST', url: '/uploads', headers: { 'x-test-account': A },
      payload: {
        ownerAccountId: B,
        displayName: 'benign.txt', purpose: 'chat', declaredSizeBytes: bytes.length,
        declaredMime: 'text/plain', declaredSha256: digest(bytes), partSizeBytes: bytes.length,
      },
    });
    expect(initiated.statusCode).toBe(201);
    const { uploadId } = initiated.json<{ uploadId: string }>();
    expect((await app.inject({ method: 'GET', url: `/uploads/${uploadId}`, headers: { 'x-test-account': B } })).statusCode).toBe(404);
    const signed = await app.inject({
      method: 'POST', url: `/uploads/${uploadId}/parts/1`, headers: { 'x-test-account': A },
      payload: { checksumSha256: digest(bytes) },
    });
    expect(signed.statusCode).toBe(200);
    const signedBody = signed.json<{ url: string; requiredHeaders: Record<string, string> }>();
    expect(signedBody.url).not.toMatch(/token|capability|\?/i);
    const capability = signedBody.requiredHeaders['x-eden-upload-capability']!;
    const put = await app.inject({
      method: 'PUT', url: `/uploads/${uploadId}/parts/1`,
      headers: {
        'content-type': 'application/octet-stream',
        'x-eden-upload-capability': capability,
      },
      payload: bytes,
    });
    expect(put.statusCode).toBe(201);
    const completed = await app.inject({
      method: 'POST', url: `/uploads/${uploadId}/complete`, headers: { 'x-test-account': A },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().object).toMatchObject({ state: 'available', url: expect.stringMatching(/^\/media\//) });
  });

  it('does not register the bearer PUT ingress for an R2-backed service', async () => {
    const app = Fastify();
    apps.push(app);
    app.decorateRequest('account', null);
    app.decorate('requireAuth', async () => undefined);
    const service = new UploadService({
      repository: new InMemoryUploadRepository(),
      backend: new RouteBackend(),
      capabilityKey: Buffer.alloc(32, 9),
      backingStore: 'r2',
      securityMode: 'test',
    });
    await app.register(uploadsRoutes, { service });
    const response = await app.inject({
      method: 'PUT',
      url: '/uploads/00000000-0000-4000-8000-000000000001/parts/1',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('blocked'),
    });
    expect(response.statusCode).toBe(404);
  });

  it('rejects invalid local capabilities before invoking the octet-stream parser', async () => {
    let now = new Date('2026-08-09T12:00:00.000Z');
    let parserCalls = 0;
    const app = Fastify();
    apps.push(app);
    app.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: UploadService.MAX_OBJECT_BYTES },
      (_request, body, done) => {
        parserCalls += 1;
        done(null, body);
      },
    );
    app.decorateRequest('account', null);
    app.decorate('requireAuth', async () => undefined);
    const backend = new RouteBackend();
    const service = new UploadService({
      repository: new InMemoryUploadRepository(),
      backend,
      capabilityKey: Buffer.alloc(32, 9),
      backingStore: 'local',
      securityMode: 'test',
      now: () => now,
    });
    await app.register(uploadsRoutes, { service });
    const bytes = Buffer.from('bounded');
    const reservation = await service.initiate(A, {
      displayName: 'bounded.txt',
      purpose: 'chat',
      declaredSizeBytes: bytes.length,
      declaredMime: 'text/plain',
      declaredSha256: digest(bytes),
      partSizeBytes: bytes.length,
    });
    const signed = await service.signPart(A, reservation.uploadId, 1, {
      checksumSha256: digest(bytes),
    });
    const capability = signed.requiredHeaders['x-eden-upload-capability']!;
    const put = (url: string, token?: string) => app.inject({
      method: 'PUT',
      url,
      headers: {
        'content-type': 'application/octet-stream',
        ...(token ? { 'x-eden-upload-capability': token } : {}),
      },
      payload: bytes,
    });

    const responses = [
      await put(`/uploads/${reservation.uploadId}/parts/1`),
      await put(`/uploads/${reservation.uploadId}/parts/1`, 'malformed'),
      await put('/uploads/00000000-0000-4000-8000-000000000001/parts/1', capability),
      await put(`/uploads/${reservation.uploadId}/parts/2`, capability),
    ];
    now = new Date('2026-08-09T12:10:00.000Z');
    responses.push(await put(`/uploads/${reservation.uploadId}/parts/1`, capability));

    expect(responses.every((response) => response.statusCode >= 400)).toBe(true);
    expect(parserCalls).toBe(0);
    expect([...backend.parts.values()].every((parts) => parts.size === 0)).toBe(true);
  });
});
