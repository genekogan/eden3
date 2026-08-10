import postgres from 'postgres';

import {
  inspectManagedPostgres,
  parseManagedPostgresUrl,
} from './managed-postgres-preflight';

async function main() {
  const databaseUrl = process.env.MANAGED_DATABASE_URL;
  const expectedDatabaseName = process.env.MANAGED_DATABASE_EXPECTED_NAME;
  if (!databaseUrl || !expectedDatabaseName) {
    throw new Error('MANAGED_DATABASE_URL and MANAGED_DATABASE_EXPECTED_NAME are required');
  }
  const authority = parseManagedPostgresUrl(databaseUrl, expectedDatabaseName);
  const client = postgres(databaseUrl, {
    max: 1,
    ssl: 'verify-full',
    connect_timeout: 10,
    idle_timeout: 1,
    onnotice: () => {},
  });
  try {
    return await client.begin('read only', async (transaction) =>
      inspectManagedPostgres(transaction, authority));
  } finally {
    await client.end({ timeout: 5 });
  }
}

main()
  .then((evidence) => console.log(JSON.stringify({ ok: true, evidence })))
  .catch(() => {
    console.error(JSON.stringify({ ok: false, error: 'managed_postgres_preflight_failed' }));
    process.exitCode = 1;
  });
