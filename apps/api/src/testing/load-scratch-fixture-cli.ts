import { pg } from '@eden3/db';
import { pathToFileURL } from 'node:url';

import {
  parseLoadScratchDatabaseUrl,
  seedLoadScratchUsers,
  type LoadScratchFixtureRepository,
  type LoadScratchUser,
} from './load-scratch-fixture';

interface QuerySql {
  <T extends readonly object[] = Record<string, unknown>[]>(
    strings: TemplateStringsArray,
    ...parameters: unknown[]
  ): PromiseLike<T>;
}

function queryOnly(sql: unknown): QuerySql {
  return sql as QuerySql;
}

export function postgresLoadScratchRepository(
  sql: QuerySql,
  begin?: <T>(operation: (transaction: QuerySql) => Promise<T>) => Promise<T>,
): LoadScratchFixtureRepository {
  const repository: LoadScratchFixtureRepository = {
    transaction: (operation) =>
      begin
        ? begin((transaction) => operation(postgresLoadScratchRepository(transaction)))
        : operation(repository),
    async currentDatabase() {
      const [row] = await sql<{ databaseName: string }[]>`
        select current_database()::text as "databaseName"
      `;
      if (!row) throw new Error('load scratch database identity was empty');
      return row.databaseName;
    },
    async currentAccounts() {
      return sql<{ id: string; username: string; type: string }[]>`
        select id::text, username::text, type
        from accounts
        order by username, id
      `;
    },
    async insertUsers(users: readonly LoadScratchUser[]) {
      for (const user of users) {
        await sql`
          insert into accounts (id, type, username, external_id, clerk_user_id, user_image, deleted)
          values (${user.id}, 'user', ${user.username}, null, null, null, false)
        `;
      }
    },
    async insertMannaAccounts(users: readonly LoadScratchUser[]) {
      for (const user of users) {
        await sql`
          insert into manna_accounts (account_id, balance, subscription_balance)
          values (${user.id}, '1000.0000', '0.0000')
        `;
      }
    },
    async mannaAccountIds() {
      const rows = await sql<{ accountId: string }[]>`
        select account_id::text as "accountId"
        from manna_accounts
        order by account_id
      `;
      return rows.map((row) => row.accountId);
    },
  };
  return repository;
}

export const loadScratchRepository = postgresLoadScratchRepository(
  queryOnly(pg),
  async (operation) =>
    (await pg.begin((sql) => operation(queryOnly(sql)))) as Awaited<ReturnType<typeof operation>>,
);

async function main() {
  if (process.argv[2] !== 'seed') {
    throw new Error('usage: load-scratch-fixture-cli.ts seed');
  }
  const rawDatabaseUrl = process.env.DATABASE_URL;
  if (!rawDatabaseUrl) throw new Error('DATABASE_URL is required');
  const { databaseName } = parseLoadScratchDatabaseUrl(rawDatabaseUrl);
  const users = await seedLoadScratchUsers({ repository: loadScratchRepository, databaseName });
  return {
    ok: true,
    databaseName,
    userCount: users.length,
    usernames: users.map((user) => user.username),
  };
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
