import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { mediaObjectRoutes } from '../src/routes/media-objects';
import {
  MediaObjectResolver,
  type MediaObjectRecord,
  type MediaObjectRepository,
} from '../src/services/media-object-repository';
import { hashSessionShareToken } from '../src/services/session-shares';

const OBJECT_ID = '00000000-0000-4000-8000-000000000001';
const OWNER = '00000000-0000-4000-8000-00000000000a';
const OTHER = '00000000-0000-4000-8000-00000000000b';
const SHARE_TOKEN = 's'.repeat(43);

function record(overrides: Partial<MediaObjectRecord> = {}): MediaObjectRecord {
  return {
    id: OBJECT_ID,
    ownerAccountId: OWNER,
    displayName: 'fixture.txt',
    state: 'available',
    backingStore: 'r2',
    backingKey: `objects/${OBJECT_ID.slice(0, 2)}/${OBJECT_ID}`,
    legacySourceUrl: 'https://legacy.invalid/private-source',
    verifiedMime: 'text/plain',
    verifiedSizeBytes: 10,
    verifiedSha256: 'a'.repeat(64),
    publicReferenceOwnerAccountId: null,
    shareReferenceActive: false,
    ...overrides,
  };
}

class FakeRepository implements MediaObjectRepository {
  row: MediaObjectRecord | null = record();
  lastShareTokenHash: string | null = null;
  activeShareTokenHash: string | null = null;
  async findById(_objectId: string, shareTokenHash: string | null = null) {
    this.lastShareTokenHash = shareTokenHash;
    return this.row && this.activeShareTokenHash !== null
      ? {
          ...this.row,
          shareReferenceActive:
            this.row.shareReferenceActive && shareTokenHash === this.activeShareTokenHash,
        }
      : this.row;
  }
}

describe('GET /media/:objectId lifecycle boundary', () => {
  const apps: ReturnType<typeof Fastify>[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function setup() {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'eden3-media-route-'));
    dirs.push(dir);
    const localPath = path.join(dir, 'verified-object');
    await writeFile(localPath, '0123456789');
    const repository = new FakeRepository();
    let hydrations = 0;
    let releases = 0;
    const resolver = new MediaObjectResolver(repository, {
      hydrate: async () => {
        hydrations += 1;
        return { localPath, release: async () => { releases += 1; } };
      },
    });
    const app = Fastify();
    apps.push(app);
    app.decorateRequest('account', null);
    app.addHook('onRequest', async (request) => {
      const accountId = request.headers['x-test-account'];
      request.account = typeof accountId === 'string'
        ? { accountId, username: accountId, isAdmin: false }
        : null;
    });
    await app.register(mediaObjectRoutes, { resolver });
    return { app, repository, counts: () => ({ hydrations, releases }) };
  }

  it.each(['pending', 'uploaded', 'verified', 'quarantined', 'failed'] as const)(
    'never hydrates or serves %s objects',
    async (state) => {
      const { app, repository, counts } = await setup();
      repository.row = record({ state });
      const response = await app.inject({
        method: 'GET', url: `/media/${OBJECT_ID}`, headers: { 'x-test-account': OWNER },
      });
      expect(response.statusCode).toBe(404);
      expect(counts().hydrations).toBe(0);
    },
  );

  it('serves an available object only to its owner and exposes no backing locator', async () => {
    const { app, counts } = await setup();
    expect((await app.inject({ method: 'GET', url: `/media/${OBJECT_ID}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/media/${OBJECT_ID}`, headers: { 'x-test-account': OTHER } })).statusCode).toBe(404);
    const response = await app.inject({
      method: 'GET', url: `/media/${OBJECT_ID}`, headers: { 'x-test-account': OWNER },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('0123456789');
    expect(response.body).not.toContain('legacy.invalid');
    expect(JSON.stringify(response.headers)).not.toContain('objects/');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(counts()).toMatchObject({ hydrations: 1, releases: 1 });
  });

  it('keeps the lifecycle route ahead of the legacy static wildcard', async () => {
    const { app } = await setup();
    const publicDir = await mkdtemp(path.join(os.tmpdir(), 'eden3-public-media-'));
    dirs.push(publicDir);
    await writeFile(path.join(publicDir, OBJECT_ID), 'public-bypass');
    await app.register(fastifyStatic, {
      root: publicDir,
      prefix: '/media/',
      index: false,
      list: false,
    });
    const anonymous = await app.inject({ method: 'GET', url: `/media/${OBJECT_ID}` });
    expect(anonymous.statusCode).toBe(404);
    expect(anonymous.body).not.toContain('public-bypass');
    const owner = await app.inject({
      method: 'GET', url: `/media/${OBJECT_ID}`, headers: { 'x-test-account': OWNER },
    });
    expect(owner.statusCode).toBe(200);
    expect(owner.body).toBe('0123456789');
  });

  it('routes legacy filenames to static media without weakening guessed-object denial', async () => {
    const { app, counts } = await setup();
    const publicDir = await mkdtemp(path.join(os.tmpdir(), 'eden3-public-media-'));
    dirs.push(publicDir);
    await writeFile(path.join(publicDir, 'legacy-render.png'), 'legacy-public-media');
    await app.register(fastifyStatic, {
      root: publicDir,
      prefix: '/media/',
      index: false,
      list: false,
    });

    const legacy = await app.inject({ method: 'GET', url: '/media/legacy-render.png' });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.body).toBe('legacy-public-media');
    expect(counts().hydrations).toBe(0);

    const guessedObject = await app.inject({ method: 'GET', url: `/media/${OBJECT_ID}` });
    expect(guessedObject.statusCode).toBe(404);
    expect(guessedObject.body).not.toContain('legacy-public-media');
    expect(counts().hydrations).toBe(0);
  });

  it('allows anonymous public references and supports HEAD and a single byte range', async () => {
    const { app, repository, counts } = await setup();
    repository.row = record({ publicReferenceOwnerAccountId: OWNER });
    const head = await app.inject({ method: 'HEAD', url: `/media/${OBJECT_ID}` });
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-length']).toBe('10');
    expect(counts().hydrations).toBe(0);
    const range = await app.inject({
      method: 'GET', url: `/media/${OBJECT_ID}`, headers: { range: 'bytes=2-5' },
    });
    expect(range.statusCode).toBe(206);
    expect(range.body).toBe('2345');
    expect(range.headers['content-range']).toBe('bytes 2-5/10');
  });

  it('does not let another tenant publish an object by guessing its durable URL', async () => {
    const { app, repository, counts } = await setup();
    repository.row = record({ publicReferenceOwnerAccountId: OTHER });
    const response = await app.inject({ method: 'GET', url: `/media/${OBJECT_ID}` });
    expect(response.statusCode).toBe(404);
    expect(counts().hydrations).toBe(0);
  });

  it('serves an exact active share reference and fails closed after revocation', async () => {
    const { app, repository, counts } = await setup();
    repository.row = record({ shareReferenceActive: true });
    const shared = await app.inject({
      method: 'GET',
      url: `/media/share/${SHARE_TOKEN}/${OBJECT_ID}`,
    });
    expect(shared.statusCode).toBe(200);
    expect(shared.body).toBe('0123456789');
    expect(repository.lastShareTokenHash).toBe(hashSessionShareToken(SHARE_TOKEN));
    expect(shared.headers['cache-control']).toContain('private');
    expect(shared.headers['cache-control']).toContain('no-store');

    repository.row = record({ shareReferenceActive: false });
    const revoked = await app.inject({
      method: 'GET',
      url: `/media/share/${SHARE_TOKEN}/${OBJECT_ID}`,
    });
    expect(revoked.statusCode).toBe(404);
    expect(revoked.headers['cache-control']).toContain('private');
    expect(revoked.headers['cache-control']).toContain('no-store');
    expect(revoked.headers['referrer-policy']).toBe('no-referrer');
    expect(JSON.stringify(revoked.headers)).not.toContain(SHARE_TOKEN);
    expect(counts().hydrations).toBe(1);
  });

  it('never makes a token-bearing media capability public-cacheable and rechecks each token', async () => {
    const { app, repository, counts } = await setup();
    const otherToken = 'z'.repeat(43);
    repository.row = record({
      publicReferenceOwnerAccountId: OWNER,
      shareReferenceActive: true,
    });
    repository.activeShareTokenHash = hashSessionShareToken(SHARE_TOKEN);

    const first = await app.inject({
      method: 'GET',
      url: `/media/share/${SHARE_TOKEN}/${OBJECT_ID}`,
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toContain('private');
    expect(first.headers['cache-control']).toContain('no-store');
    expect(first.headers['cache-control']).not.toContain('public');
    expect(first.headers['surrogate-control']).toBe('no-store');
    expect(first.headers['referrer-policy']).toBe('no-referrer');

    const crossToken = await app.inject({
      method: 'HEAD',
      url: `/media/share/${otherToken}/${OBJECT_ID}`,
    });
    expect(crossToken.statusCode).toBe(404);
    expect(crossToken.headers['cache-control']).toContain('no-store');
    expect(counts().hydrations).toBe(1);
  });

  it('keeps the Postgres public-reference query owner-bound and moderation-bound', async () => {
    const source = await readFile(
      new URL('../src/services/media-object-postgres-repository.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('c.user_id = o.owner_account_id');
    expect(source.match(/publicCreationModerationSql\(pg\)/g)).toHaveLength(1);
    expect(source).not.toContain("attributes->>'nsfw_score'");
    expect(source).not.toContain('!~');
    expect(source).toContain('s.deleted = false');
    expect(source).toContain('s.visible is distinct from false');
    expect(source).toContain('a.id = o.owner_account_id');
    expect(source).toContain('su.user_account_id = o.owner_account_id');
    expect(source).toContain('sa.agent_account_id = o.owner_account_id');
  });

  it('rejects available rows missing verified metadata before hydration', async () => {
    const { app, repository, counts } = await setup();
    repository.row = record({ verifiedSha256: null });
    const response = await app.inject({
      method: 'GET', url: `/media/${OBJECT_ID}`, headers: { 'x-test-account': OWNER },
    });
    expect(response.statusCode).toBe(404);
    expect(counts().hydrations).toBe(0);
  });
});
