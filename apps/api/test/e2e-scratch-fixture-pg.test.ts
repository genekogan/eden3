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
    ).rejects.toThrow(/platform Eve baseline/);
    await pg`update accounts set clerk_user_id = null where id = ${fixtureId}`;

    const [eve] = await pg<{
      accountId: string;
      name: string;
      description: string;
      persona: string;
      isPersonaPublic: boolean;
      greeting: string;
      public: boolean;
      toolGroups: unknown;
      isPilot: boolean;
      isSynthetic: boolean;
      provisionStatus: string;
      provisionedAt: Date;
    }[]>`
      select g.account_id::text as "accountId", g.name, g.description, g.persona,
             g.is_persona_public as "isPersonaPublic", g.greeting, g.public,
             g.tool_groups as "toolGroups", g.is_pilot as "isPilot",
             g.is_synthetic as "isSynthetic", g.provision_status as "provisionStatus",
             g.provisioned_at as "provisionedAt"
      from agents g
      where g.openclaw_id = 'main' and g.owner_id is null
    `;
    expect(eve).toBeDefined();
    const expectCanonicalDriftRejected = async () =>
      expect(
        preflightE2EScratchUser({
          repository: e2eScratchPostgresRepository,
          databaseName,
          fetchUsers: async () =>
            (await app.inject({ method: 'GET', url: '/dev/users?q=gene' })).json(),
        }),
      ).rejects.toThrow(/platform Eve baseline/);
    const mutations: {
      field: string;
      mutate: () => Promise<void>;
      restore: () => Promise<void>;
    }[] = [
      {
        field: 'name',
        mutate: async () => void (await pg`update agents set name = 'Eve drift' where account_id = ${eve!.accountId}`),
        restore: async () => void (await pg`update agents set name = ${eve!.name} where account_id = ${eve!.accountId}`),
      },
      {
        field: 'description',
        mutate: async () => void (await pg`update agents set description = 'drift' where account_id = ${eve!.accountId}`),
        restore: async () => void (await pg`update agents set description = ${eve!.description} where account_id = ${eve!.accountId}`),
      },
      {
        field: 'persona',
        mutate: async () => void (await pg`update agents set persona = 'drift' where account_id = ${eve!.accountId}`),
        restore: async () => void (await pg`update agents set persona = ${eve!.persona} where account_id = ${eve!.accountId}`),
      },
      {
        field: 'is_persona_public',
        mutate: async () => void (await pg`update agents set is_persona_public = false where account_id = ${eve!.accountId}`),
        restore: async () => void (await pg`update agents set is_persona_public = ${eve!.isPersonaPublic} where account_id = ${eve!.accountId}`),
      },
      {
        field: 'greeting',
        mutate: async () => void (await pg`update agents set greeting = 'drift' where account_id = ${eve!.accountId}`),
        restore: async () => void (await pg`update agents set greeting = ${eve!.greeting} where account_id = ${eve!.accountId}`),
      },
      {
        field: 'public',
        mutate: async () => void (await pg`update agents set public = false where account_id = ${eve!.accountId}`),
        restore: async () => void (await pg`update agents set public = ${eve!.public} where account_id = ${eve!.accountId}`),
      },
      {
        field: 'tool_groups',
        mutate: async () => void (await pg`update agents set tool_groups = '["group:web"]'::jsonb where account_id = ${eve!.accountId}`),
        restore: async () => void (await pg`update agents set tool_groups = ${JSON.stringify(eve!.toolGroups)}::jsonb where account_id = ${eve!.accountId}`),
      },
      {
        field: 'is_pilot',
        mutate: async () => void (await pg`update agents set is_pilot = false where account_id = ${eve!.accountId}`),
        restore: async () => void (await pg`update agents set is_pilot = ${eve!.isPilot} where account_id = ${eve!.accountId}`),
      },
      {
        field: 'is_synthetic',
        mutate: async () => void (await pg`update agents set is_synthetic = true where account_id = ${eve!.accountId}`),
        restore: async () => void (await pg`update agents set is_synthetic = ${eve!.isSynthetic} where account_id = ${eve!.accountId}`),
      },
      {
        field: 'provision_status',
        mutate: async () => void (await pg`update agents set provision_status = 'pending' where account_id = ${eve!.accountId}`),
        restore: async () => void (await pg`update agents set provision_status = ${eve!.provisionStatus} where account_id = ${eve!.accountId}`),
      },
      {
        field: 'provisioned_at',
        mutate: async () => void (await pg`update agents set provisioned_at = null where account_id = ${eve!.accountId}`),
        restore: async () => void (await pg`update agents set provisioned_at = ${eve!.provisionedAt} where account_id = ${eve!.accountId}`),
      },
    ];
    for (const mutation of mutations) {
      await mutation.mutate();
      await expectCanonicalDriftRejected();
      await mutation.restore();
      expect(mutation.field).toBeTruthy();
    }
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
    const [counts] = await pg<{ accounts: number; agents: number; usage: number }[]>`
      select (select count(*)::int from accounts) as accounts,
             (select count(*)::int from agents) as agents,
             (select count(*)::int from usage_events) as usage
    `;
    expect(counts).toEqual({ accounts: 1, agents: 1, usage: 0 });
  });
});
