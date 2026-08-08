import { pg } from '@eden3/db';

import {
  assertE2EScratchAccountInventory,
  assertNoE2EScratchSideEffects,
  e2eScratchUser,
  parseE2EScratchDatabaseUrl,
  verifyE2EScratchPreflight,
  type E2EScratchSideEffects,
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
}

function queryOnly(sql: unknown): QuerySql {
  return sql as QuerySql;
}

function safeApiUrl(raw: string): URL {
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

async function accountRows(sql: QuerySql = queryOnly(pg)) {
  return sql<
    {
      id: string;
      type: string;
      username: string;
      externalId: string | null;
      clerkUserId: string | null;
      userImage: string | null;
      deleted: boolean;
    }[]
  >`
    select id::text,
           type,
           username::text,
           external_id as "externalId",
           clerk_user_id as "clerkUserId",
           user_image as "userImage",
           deleted
    from accounts
    order by id
  `;
}

async function sideEffectCounts(
  sql: QuerySql = queryOnly(pg),
): Promise<E2EScratchSideEffects> {
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
}

async function assertCurrentDatabase(sql: QuerySql, expected: string): Promise<void> {
  const [row] = await sql<{ databaseName: string }[]>`
    select current_database()::text as "databaseName"
  `;
  if (row?.databaseName !== expected) {
    throw new Error('scratch fixture connected to an unexpected database');
  }
}

async function seed(databaseName: string) {
  const fixture = e2eScratchUser(databaseName);
  let action: 'insert' | 'existing' = 'existing';
  await pg.begin(async (sql) => {
    const query = queryOnly(sql);
    await assertCurrentDatabase(query, databaseName);
    action = assertE2EScratchAccountInventory(await accountRows(query), fixture);
    if (action === 'insert') {
      await sql`
        insert into accounts
          (id, type, username, external_id, clerk_user_id, user_image, deleted)
        values
          (${fixture.id}, 'user', 'gene', null, null, null, false)
      `;
    }
    if (assertE2EScratchAccountInventory(await accountRows(query), fixture) !== 'existing') {
      throw new Error('scratch fixture insert did not converge');
    }
    assertNoE2EScratchSideEffects(await sideEffectCounts(query));
  });
  return { ok: true, action, databaseName, userId: fixture.id };
}

async function preflight(databaseName: string, rawApiUrl: string) {
  const fixture = e2eScratchUser(databaseName);
  const apiUrl = safeApiUrl(rawApiUrl);
  await assertCurrentDatabase(queryOnly(pg), databaseName);
  await verifyE2EScratchPreflight({
    fixture,
    fetchUsers: async () => {
      const response = await fetch(new URL('/dev/users?q=gene', apiUrl), {
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error('isolated E2E API user preflight failed');
      return response.json();
    },
    readSideEffects: () => sideEffectCounts(queryOnly(pg)),
  });
  return { ok: true, databaseName, userId: fixture.id, sideEffects: 'none' };
}

async function cleanup(databaseName: string) {
  const fixture = e2eScratchUser(databaseName);
  let removed = false;
  await pg.begin(async (sql) => {
    const query = queryOnly(sql);
    await assertCurrentDatabase(query, databaseName);
    const rows = await accountRows(query);
    if (rows.length === 0) return;
    if (assertE2EScratchAccountInventory(rows, fixture) !== 'existing') return;
    assertNoE2EScratchSideEffects(await sideEffectCounts(query));
    const deleted = await sql<{ id: string }[]>`
      delete from accounts
      where id = ${fixture.id}
        and type = 'user'
        and username = 'gene'
        and external_id is null
        and clerk_user_id is null
      returning id::text
    `;
    if (deleted.length !== 1 || deleted[0]?.id !== fixture.id) {
      throw new Error('scratch fixture cleanup did not delete the exact user');
    }
    if ((await accountRows(query)).length !== 0) {
      throw new Error('scratch fixture cleanup left an account behind');
    }
    removed = true;
  });
  return { ok: true, databaseName, userId: fixture.id, removed };
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

main()
  .then((result) => console.log(JSON.stringify(result)))
  .catch((error) => {
    console.error(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
    process.exitCode = 1;
  })
  .finally(() => pg.end({ timeout: 5 }));
