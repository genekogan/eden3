import postgres from 'postgres';

import { parseManagedPostgresUrl } from './managed-postgres-preflight';
import { bootstrapManagedRuntimeRole } from './managed-runtime-bootstrap';

async function main() {
  const databaseUrl = process.env.MANAGED_DATABASE_URL;
  const databaseName = process.env.MANAGED_DATABASE_EXPECTED_NAME;
  const roleName = process.env.MANAGED_RUNTIME_ROLE;
  const password = process.env.MANAGED_RUNTIME_PASSWORD;
  if (!databaseUrl || !databaseName || !roleName || !password) {
    throw new Error('managed runtime bootstrap environment is incomplete');
  }
  parseManagedPostgresUrl(databaseUrl, databaseName);
  const client = postgres(databaseUrl, {
    max: 1,
    ssl: 'verify-full',
    connect_timeout: 10,
    idle_timeout: 1,
    onnotice: () => {},
  });
  try {
    return await client.begin((transaction) =>
      bootstrapManagedRuntimeRole(transaction, { databaseName, roleName, password }));
  } finally {
    await client.end({ timeout: 5 });
  }
}

main()
  .then((evidence) => console.log(JSON.stringify({ ok: true, evidence })))
  .catch(() => {
    console.error(JSON.stringify({ ok: false, error: 'managed_runtime_bootstrap_failed' }));
    process.exitCode = 1;
  });
