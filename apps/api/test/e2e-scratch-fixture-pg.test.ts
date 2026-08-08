import type { PgClient } from '@eden3/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  cleanupE2EScratchUser,
  parseE2EScratchDatabaseUrl,
  preflightE2EScratchUser,
  seedE2EScratchUser,
  type E2EScratchFixtureRepository,
} from '../src/testing/e2e-scratch-fixture';

const enabled = process.env.EDEN3_E2E_FIXTURE_PG === '1';
const integration = enabled ? describe : describe.skip;

integration('isolated E2E scratch fixture (disposable Postgres)', () => {
  let app: FastifyInstance;
  let databaseName: string;
  let fixtureId: string;
  let pg: PgClient;
  let e2eScratchPostgresRepository: E2EScratchFixtureRepository;

  beforeAll(async () => {
    const rawDatabaseUrl = process.env.DATABASE_URL;
    if (!rawDatabaseUrl) throw new Error('DATABASE_URL is required');
    databaseName = parseE2EScratchDatabaseUrl(rawDatabaseUrl).databaseName;
    process.env.EDEN3_DEV_ROUTES = '1';
    process.env.AUTH_PROVIDER = 'dev';
    const [{ resetEnvCache }, dbModule, serverModule, fixtureCli] = await Promise.all([
      import('@eden3/core'),
      import('@eden3/db'),
      import('../src/server'),
      import('../src/testing/e2e-scratch-fixture-cli'),
    ]);
    pg = dbModule.pg;
    e2eScratchPostgresRepository = fixtureCli.e2eScratchPostgresRepository;
    resetEnvCache();
    const seeded = await seedE2EScratchUser({
      repository: e2eScratchPostgresRepository,
      databaseName,
    });
    fixtureId = seeded.fixture.id;
    app = await serverModule.buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await pg.end({ timeout: 5 });
  });

  it('binds the exact HTTP user projection back to the full Postgres identity', async () => {
    const fixture = await preflightE2EScratchUser({
      repository: e2eScratchPostgresRepository,
      databaseName,
      fetchUsers: async () => {
        const response = await app.inject({ method: 'GET', url: '/dev/users?q=gene' });
        expect(response.statusCode).toBe(200);
        return response.json();
      },
    });
    expect(fixture.id).toBe(fixtureId);

    await pg`update accounts set clerk_user_id = 'forbidden_fixture_subject' where id = ${fixtureId}`;
    await expect(
      preflightE2EScratchUser({
        repository: e2eScratchPostgresRepository,
        databaseName,
        fetchUsers: async () => (await app.inject({ method: 'GET', url: '/dev/users?q=gene' })).json(),
      }),
    ).rejects.toThrow(/exact synthetic scratch user/);
    await pg`update accounts set clerk_user_id = null where id = ${fixtureId}`;
  });

  it('locks the exact owner row so a concurrent FK writer cannot be laundered by cleanup', async () => {
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    let releaseCleanup!: () => void;
    const cleanupReleased = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const blockingRepository: E2EScratchFixtureRepository = {
      ...e2eScratchPostgresRepository,
      transaction: (operation) =>
        e2eScratchPostgresRepository.transaction((transaction) =>
          operation({
            ...transaction,
            accountRows: async (options) => {
              const rows = await transaction.accountRows(options);
              if (options?.forUpdate) {
                signalLocked();
                await cleanupReleased;
              }
              return rows;
            },
          }),
        ),
    };

    const cleanup = cleanupE2EScratchUser({ repository: blockingRepository, databaseName });
    await locked;
    let writerSettled = false;
    const writer = pg`
      insert into usage_events (event_type, status, user_id)
      values ('e2e_fixture_race', 'started', ${fixtureId})
    `.finally(() => {
      writerSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(writerSettled).toBe(false);
    releaseCleanup();
    await expect(cleanup).resolves.toMatchObject({ removed: true });
    await expect(writer).rejects.toThrow();
    const [counts] = await pg<{ accounts: number; usage: number }[]>`
      select (select count(*)::int from accounts) as accounts,
             (select count(*)::int from usage_events) as usage
    `;
    expect(counts).toEqual({ accounts: 0, usage: 0 });
  });
});
