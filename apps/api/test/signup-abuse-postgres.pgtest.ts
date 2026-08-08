import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ModelRuntimeCatalogLike } from '../src/gateway-glue';

const SCRATCH_DATABASE = process.env.SIGNUP_ABUSE_SCRATCH_DATABASE;
const SCRATCH_NAME = /^eden3_signup_abuse_[a-z0-9]+$/;

let app: FastifyInstance;
let pg: typeof import('@eden3/db').pg;
let ownerId = '';
let provisionedUsernames: string[] = [];

function selectScratchDatabase(): void {
  if (!SCRATCH_DATABASE) {
    throw new Error('SIGNUP_ABUSE_SCRATCH_DATABASE is required for this lease-bound proof');
  }
  if (!SCRATCH_NAME.test(SCRATCH_DATABASE)) throw new Error('unsafe signup-abuse scratch name');
  const source = process.env.DATABASE_URL;
  if (!source) throw new Error('DATABASE_URL is required for the disposable PostgreSQL proof');
  const url = new URL(source);
  url.pathname = `/${SCRATCH_DATABASE}`;
  url.search = '';
  process.env.DATABASE_URL = url.toString();
  process.env.MAX_NATIVE_AGENTS_PER_USER = '2';
  process.env.CHANNEL_TOKEN_ENCRYPTION_KEY = '11'.repeat(32);
}

beforeAll(async () => {
  selectScratchDatabase();
  const core = await import('@eden3/core');
  core.resetEnvCache();
  const dbModule = await import('@eden3/db');
  pg = dbModule.pg;
  const databaseRows = await pg<{ database: string }[]>`select current_database() as database`;
  const database = databaseRows[0]?.database;
  expect(database).toBe(SCRATCH_DATABASE);

  const marker = 'signup_pg_owner';
  const ownerRows = await pg<{ id: string }[]>`
    insert into accounts (type, username)
    values ('user', ${marker})
    returning id
  `;
  ownerId = ownerRows[0]?.id ?? '';
  if (!ownerId) throw new Error('failed to insert signup-abuse proof owner');

  const [{ buildServer }, fixtures] = await Promise.all([
    import('../src/server'),
    import('./fixtures'),
  ]);
  const provisioner = fixtures.makeFakeProvisioner();
  const originalProvision = provisioner.provisionAgent.bind(provisioner);
  provisioner.provisionAgent = async (params, options) => {
    provisionedUsernames.push(params.username);
    return originalProvision(params, options);
  };
  const modelRuntime: ModelRuntimeCatalogLike = {
    getCatalog: async () => [
      { model: 'anthropic/claude-haiku-4-5', agentRuntime: 'openclaw' },
    ],
    getRuntime: async () => 'openclaw',
    setRuntime: async (model, agentRuntime) => ({
      changed: false,
      model,
      agentRuntime,
    }),
  };
  app = await buildServer({
    auth: {
      provider: new core.DevAuthProvider(),
      accessAllowlist: [marker],
    },
    gateway: null,
    provisioning: {
      provisioner,
      cronSync: fixtures.makeFakeCronSync(),
      skillSync: fixtures.makeFakeSkillSync(),
      toolSync: fixtures.makeFakeToolSync(),
      modelRuntime,
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await pg?.end({ timeout: 5 });
});

describe('FG-SIGNUP-ABUSE real PostgreSQL native-agent quota', () => {
  it('serializes concurrent create and import, with zero loser side effects', async () => {
    const { devCookie } = await import('./fixtures');
    const requests = Array.from({ length: 8 }, (_, index) => {
      const username = `signup-pg-${index}`;
      const kind = index % 2 === 0 ? 'create' : 'import';
      const request =
        kind === 'create'
          ? app.inject({
              method: 'POST',
              url: '/agents',
              headers: { cookie: devCookie(ownerId) },
              payload: { username, name: `Create ${index}` },
            })
          : app.inject({
              method: 'POST',
              url: '/agents/import',
              headers: { cookie: devCookie(ownerId) },
              payload: {
                username,
                bundle: {
                  kind: 'eden3.agent.bundle',
                  version: 1,
                  agent: { username, name: `Import ${index}` },
                  memory: { items: [] },
                  skills: [],
                },
              },
            });
      return { username, kind, request };
    });

    const responses = await Promise.all(
      requests.map(async ({ username, kind, request }) => ({
        username,
        kind,
        response: await request,
      })),
    );
    const winners = responses.filter(({ response }) => response.statusCode === 201);
    const losers = responses.filter(({ response }) => response.statusCode !== 201);
    expect(winners).toHaveLength(2);
    expect(losers).toHaveLength(6);
    for (const { response } of losers) {
      expect(response.statusCode).toBe(429);
      expect(response.json()).toMatchObject({ error: { code: 'agent_quota_exceeded' } });
    }

    const winnerNames = new Set(winners.map(({ username }) => username));
    const loserNames = losers.map(({ username }) => username);
    const nativeCountRows = await pg<{ count: number }[]>`
      select count(*)::int as count
      from agents g
      join accounts a on a.id = g.account_id
      where g.owner_id = ${ownerId}
        and a.external_id is null
        and a.deleted = false
    `;
    const finalNativeCount = nativeCountRows[0]?.count;
    expect(finalNativeCount).toBe(2);

    const loserRows = await pg<{ username: string }[]>`
      select username::text as username
      from accounts
      where username = any(${loserNames}::citext[])
    `;
    expect(loserRows).toEqual([]);

    const provisionJobs = await pg<{ username: string }[]>`
      select a.username::text as username
      from agent_provision_jobs j
      join accounts a on a.id = j.agent_account_id
      where a.username like 'signup-pg-%'
    `;
    expect(provisionJobs.every(({ username }) => winnerNames.has(username))).toBe(true);
    expect(provisionJobs.map(({ username }) => username).sort()).toEqual(
      winners
        .filter(({ kind }) => kind === 'create')
        .map(({ username }) => username)
        .sort(),
    );

    expect(provisionedUsernames.every((username) => winnerNames.has(username))).toBe(true);
    expect(provisionedUsernames.sort()).toEqual(
      winners
        .filter(({ kind }) => kind === 'import')
        .map(({ username }) => username)
        .sort(),
    );

    const mannaRows = await pg<{ count: number }[]>`
      select count(*)::int as count
      from manna_accounts ma
      join accounts a on a.id = ma.account_id
      where a.username like 'signup-pg-%'
    `;
    const mannaSideEffects = mannaRows[0]?.count;
    expect(mannaSideEffects).toBe(0);
  });
});
