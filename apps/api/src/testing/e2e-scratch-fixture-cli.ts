import { pg } from '@eden3/db';
import { pathToFileURL } from 'node:url';

import {
  cleanupE2EScratchUser,
  parseE2EScratchDatabaseUrl,
  preflightE2EScratchUser,
  seedE2EScratchUser,
  type E2EScratchFixtureRepository,
  type E2EScratchSideEffects,
  type E2EScratchUser,
} from './e2e-scratch-fixture';

/**
 * Test-only disposable-Postgres fixture seam. Run through:
 *   DATABASE_URL=postgres://.../eden3_runtime_e2e_<run> pnpm --filter @eden3/api exec tsx src/testing/e2e-scratch-fixture-cli.ts seed
 * and, after the alt-port API is healthy, the same command with `preflight`
 * plus a loopback API_URL. It refuses protected/shared databases before its
 * first query and never reads or copies a real account.
 */

interface QuerySql {
  <T extends readonly object[] = Record<string, unknown>[]>(
    strings: TemplateStringsArray,
    ...parameters: unknown[]
  ): PromiseLike<T>;
  unsafe<T extends readonly object[] = Record<string, unknown>[]>(query: string): PromiseLike<T>;
}

function queryOnly(sql: unknown): QuerySql {
  return sql as QuerySql;
}

export function safeApiUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('invalid isolated E2E API URL');
  }
  const port = Number(url.port);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !Number.isSafeInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    port === 4301 ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new Error('invalid isolated E2E API URL');
  }
  return url;
}

export function postgresRepository(
  sql: QuerySql,
  begin?: <T>(operation: (transaction: QuerySql) => Promise<T>) => Promise<T>,
): E2EScratchFixtureRepository {
  const repository: E2EScratchFixtureRepository = {
    transaction: (operation) =>
      begin
        ? begin((transaction) => operation(postgresRepository(transaction)))
        : operation(repository),
    async currentDatabase() {
      const [row] = await sql<{ databaseName: string }[]>`
        select current_database()::text as "databaseName"
      `;
      if (!row) throw new Error('scratch fixture database identity was empty');
      return row.databaseName;
    },
    async accountRows(options = {}) {
      const select = `
        select id::text,
               type,
               username::text,
               external_id as "externalId",
               clerk_user_id as "clerkUserId",
               user_image as "userImage",
               deleted
        from accounts
        order by id`;
      return options.forUpdate
        ? await sql`
            select id::text,
                   type,
                   username::text,
                   external_id as "externalId",
                   clerk_user_id as "clerkUserId",
                   user_image as "userImage",
                   deleted
            from accounts
            order by id
            for update
          `
        : await sql.unsafe(select);
    },
    async insertUser(fixture) {
      await sql`
        insert into accounts
          (id, type, username, external_id, clerk_user_id, user_image, deleted)
        values
          (${fixture.id}, ${fixture.type}, ${fixture.username}, null, null, null, false)
      `;
    },
    async sideEffectCounts() {
      const [counts] = await sql<E2EScratchSideEffects[]>`
        select (select count(*)::int from accounts) as "accountCount",
               (select count(*)::int from agents) as "agentCount",
               (select count(*)::int from sessions) as "sessionCount",
               (select count(*)::int from usage_events) as "usageCount",
               (select count(*)::int from turn_provider_runs) as "providerRunCount",
               (select count(*)::int from manna_accounts) as "mannaAccountCount",
               (select count(*)::int from manna_transactions) as "mannaTransactionCount"
      `;
      if (!counts) throw new Error('scratch fixture side-effect inventory was empty');
      return counts;
    },
    async deleteExactUser(fixture: E2EScratchUser) {
      const rows = await sql<{ id: string }[]>`
        delete from accounts
        where id = ${fixture.id}
          and type = ${fixture.type}
          and username = ${fixture.username}
          and external_id is null
          and clerk_user_id is null
          and user_image is null
          and deleted = false
        returning id::text
      `;
      return rows.map((row) => row.id);
    },
  };
  return repository;
}

export const e2eScratchPostgresRepository = postgresRepository(
  queryOnly(pg),
  async (operation) =>
  (await pg.begin((sql) => operation(queryOnly(sql)))) as Awaited<ReturnType<typeof operation>>,
);

async function seed(databaseName: string) {
  const result = await seedE2EScratchUser({
    repository: e2eScratchPostgresRepository,
    databaseName,
  });
  return { ok: true, action: result.action, databaseName, userId: result.fixture.id };
}

async function preflight(databaseName: string, rawApiUrl: string) {
  const apiUrl = safeApiUrl(rawApiUrl);
  const fixture = await preflightE2EScratchUser({
    repository: e2eScratchPostgresRepository,
    databaseName,
    fetchUsers: async () => {
      const response = await fetch(new URL('/dev/users?q=gene', apiUrl), {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error('isolated E2E API user preflight failed');
      return response.json();
    },
  });
  return { ok: true, databaseName, userId: fixture.id, sideEffects: 'none' };
}

async function cleanup(databaseName: string) {
  const result = await cleanupE2EScratchUser({
    repository: e2eScratchPostgresRepository,
    databaseName,
  });
  return { ok: true, databaseName, userId: result.fixture.id, removed: result.removed };
}

async function main() {
  const command = process.argv[2];
  const rawDatabaseUrl = process.env.DATABASE_URL;
  if (!rawDatabaseUrl) throw new Error('DATABASE_URL is required');
  const { databaseName } = parseE2EScratchDatabaseUrl(rawDatabaseUrl);
  if (command === 'seed') return seed(databaseName);
  if (command === 'preflight') {
    const apiUrl = process.env.API_URL;
    if (!apiUrl) throw new Error('API_URL is required for preflight');
    return preflight(databaseName, apiUrl);
  }
  if (command === 'cleanup') return cleanup(databaseName);
  throw new Error('usage: e2e-scratch-fixture-cli.ts seed|preflight|cleanup');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
      process.exitCode = 1;
    })
    .finally(() => pg.end({ timeout: 5 }));
}
