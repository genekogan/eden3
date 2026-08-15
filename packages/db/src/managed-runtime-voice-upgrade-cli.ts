import { createHash } from 'node:crypto';

import postgres from 'postgres';

import { parseManagedPostgresUrl } from './managed-postgres-preflight';
import { upgradeManagedRuntimeVoicePrivilege } from './managed-runtime-bootstrap';

async function main() {
  const databaseUrl = process.env.MANAGED_DATABASE_URL;
  const databaseName = process.env.MANAGED_DATABASE_EXPECTED_NAME;
  const roleName = process.env.MANAGED_RUNTIME_ROLE;
  if (!databaseUrl || !databaseName || !roleName) {
    throw new Error('managed runtime voice upgrade environment is incomplete');
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
    await client.begin(async (transaction) => {
      await upgradeManagedRuntimeVoicePrivilege(transaction, roleName);
    });
    return {
      databaseName,
      roleSha256: createHash('sha256').update(roleName).digest('hex'),
      privilege: 'account_erasure_assert_voice_output_writable(text):EXECUTE',
    };
  } finally {
    await client.end({ timeout: 5 });
  }
}

main()
  .then((evidence) => console.log(JSON.stringify({ ok: true, evidence })))
  .catch(() => {
    console.error(JSON.stringify({ ok: false, error: 'managed_runtime_voice_upgrade_failed' }));
    process.exitCode = 1;
  });
