import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import { localDisposableDatabaseUrl } from '../fixtures/disposable-database';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));
const scratchDatabases: string[] = [];
const scratchRoots: string[] = [];
const scratchPattern = /^t21b_local_[a-f0-9]{8}$/;

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sourceDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is required for disposable local-backend proof');
  return raw;
}

function urlForDatabase(database: string): string {
  return localDisposableDatabaseUrl(sourceDatabaseUrl(), database, scratchPattern);
}

async function createScratchDatabase(): Promise<{ name: string; url: string }> {
  const name = `t21b_local_${randomUUID().slice(0, 8)}`;
  const admin = postgres(urlForDatabase('postgres'), { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe(`create database "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  scratchDatabases.push(name);
  console.info(`local storage scratch database: ${name}`);
  return { name, url: urlForDatabase(name) };
}

afterAll(async () => {
  await Promise.all(scratchRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  if (scratchDatabases.length === 0) return;
  const admin = postgres(urlForDatabase('postgres'), { max: 1, onnotice: () => undefined });
  try {
    for (const name of scratchDatabases) {
      if (!scratchPattern.test(name)) throw new Error(`refusing to drop ${name}`);
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
});

describe('local resumable uploads against disposable PostgreSQL', () => {
  it('resumes across service instances and keeps pending/quarantined/cross-tenant objects unreachable', async () => {
    const database = await createScratchDatabase();
    const migrationClient = postgres(database.url, { max: 1, onnotice: () => undefined });
    await migrate(drizzle(migrationClient), { migrationsFolder: MIGRATIONS_DIR });
    await migrationClient.end({ timeout: 5 });

    process.env.DATABASE_URL = database.url;
    const [{ LocalObjectBackend, ObjectService, StagingCache }, { pg }] = await Promise.all([
      import('../../../core/src/media-store'),
      import('@eden3/db'),
    ]);
    const [
      { ObjectBackendUploadAdapter },
      { PostgresUploadRepository },
      { UploadService },
      { MediaObjectResolver },
      { PostgresMediaObjectRepository },
    ] = await Promise.all([
      import('../../../../apps/api/src/services/upload-object-backend'),
      import('../../../../apps/api/src/services/upload-postgres-repository'),
      import('../../../../apps/api/src/services/upload-service'),
      import('../../../../apps/api/src/services/media-object-repository'),
      import('../../../../apps/api/src/services/media-object-postgres-repository'),
    ]);

    const root = await mkdtemp(path.join(os.tmpdir(), 'eden3-local-storage-itest-'));
    scratchRoots.push(root);
    const mediaDir = path.join(root, 'public-media');
    const objectRoot = path.join(root, 'private-objects');
    const cacheRoot = path.join(root, 'private-cache');
    await mkdir(mediaDir);
    const backend = new LocalObjectBackend({ root: objectRoot });
    const adapter = new ObjectBackendUploadAdapter(backend);
    const capabilityKey = Buffer.alloc(32, 7);
    const worker = { tick: async () => ({ claimed: 0, delivered: 0, retried: 0 }) };
    const options = {
      repository: new PostgresUploadRepository(),
      backend: adapter,
      capabilityKey,
      backingStore: 'local' as const,
      policyScanner: async () => ({ quarantineReason: null }),
      policyEventWorker: worker,
      securityMode: 'production' as const,
    };
    const firstService = new UploadService(options);
    const secondService = new UploadService({ ...options, repository: new PostgresUploadRepository() });
    const resolver = new MediaObjectResolver(
      new PostgresMediaObjectRepository(),
      new ObjectService({
        backend,
        cache: new StagingCache({ root: cacheRoot, maxUnpinnedBytes: 1024 * 1024 }),
      }),
    );

    try {
      const [owner] = await pg<{ id: string }[]>`
        insert into accounts (type, username) values ('user', ${`local_owner_${randomUUID()}`}) returning id`;
      const [other] = await pg<{ id: string }[]>`
        insert into accounts (type, username) values ('user', ${`local_other_${randomUUID()}`}) returning id`;
      const body = Buffer.from('hello world');
      const reservation = await firstService.initiate(owner!.id, {
        displayName: 'proof.txt',
        purpose: 'chat',
        declaredSizeBytes: body.length,
        declaredMime: 'text/plain',
        declaredSha256: sha256(body),
        partSizeBytes: 6,
      });
      await expect(resolver.resolve(reservation.objectId, owner!.id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(secondService.status(other!.id, reservation.uploadId)).rejects.toMatchObject({ statusCode: 404 });

      const firstPart = body.subarray(0, 6);
      const firstCapability = await firstService.signPart(owner!.id, reservation.uploadId, 1, {
        checksumSha256: sha256(firstPart),
      });
      expect(firstCapability.url).toBe(`/uploads/${reservation.uploadId}/parts/1`);
      expect(firstCapability.url).not.toMatch(/token|capability/i);
      const firstToken = firstCapability.requiredHeaders['x-eden-upload-capability'];
      expect(firstToken).toBeTruthy();
      await firstService.putLocalPart(firstToken!, firstPart, {
        expectedUploadId: reservation.uploadId,
        expectedPartNumber: 1,
      });

      const resumed = await secondService.status(owner!.id, reservation.uploadId);
      expect(resumed.nextOffset).toBe(6);
      expect(resumed.completedParts.map((part) => part.partNumber)).toEqual([1]);
      const secondPart = body.subarray(6);
      const secondCapability = await secondService.signPart(owner!.id, reservation.uploadId, 2, {
        checksumSha256: sha256(secondPart),
      });
      await secondService.putLocalPart(
        secondCapability.requiredHeaders['x-eden-upload-capability']!,
        secondPart,
        { expectedUploadId: reservation.uploadId, expectedPartNumber: 2 },
      );
      const completion = await secondService.complete(owner!.id, reservation.uploadId);
      expect(completion.object.state).toBe('available');
      await expect(resolver.resolve(reservation.objectId, other!.id)).rejects.toMatchObject({ statusCode: 404 });
      const available = await resolver.resolve(reservation.objectId, owner!.id);
      const hydrated = await resolver.hydrator.hydrate(available.storedObject, { displayName: 'proof.txt' });
      expect(await readFile(hydrated.localPath)).toEqual(body);
      await hydrated.release();

      const archive = Buffer.from('PK\x03\x04synthetic archive');
      const quarantined = await firstService.initiate(owner!.id, {
        displayName: 'blocked.zip',
        purpose: 'chat',
        declaredSizeBytes: archive.length,
        declaredMime: 'application/zip',
        declaredSha256: sha256(archive),
        partSizeBytes: archive.length,
      });
      const archiveCapability = await firstService.signPart(owner!.id, quarantined.uploadId, 1, {
        checksumSha256: sha256(archive),
      });
      await firstService.putLocalPart(
        archiveCapability.requiredHeaders['x-eden-upload-capability']!,
        archive,
        { expectedUploadId: quarantined.uploadId, expectedPartNumber: 1 },
      );
      await expect(firstService.complete(owner!.id, quarantined.uploadId))
        .rejects.toMatchObject({ code: 'upload_quarantined' });
      await expect(resolver.resolve(quarantined.objectId, owner!.id)).rejects.toMatchObject({ statusCode: 404 });
      const [outbox] = await pg<{ state: string; event_type: string }[]>`
        select state, event_type from storage_policy_events where object_id = ${quarantined.objectId}`;
      expect(outbox).toEqual({ state: 'pending', event_type: 'quarantine_required' });

      expect(path.relative(await realpath(mediaDir), await realpath(objectRoot))).toMatch(/^\.\./);
      await expect(access(path.join(mediaDir, 'objects', reservation.objectId))).rejects.toThrow();
    } finally {
      await pg.end({ timeout: 5 });
    }
  });
});
