import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import postgres from 'postgres';

import { parseManagedPostgresUrl } from './managed-postgres-preflight';
import { upgradeManagedRuntimeVoicePrivilege } from './managed-runtime-bootstrap';

export function assertManagedVoiceUpgradeUrls(
  ownerRaw: string,
  runtimeRaw: string,
  databaseName: string,
  roleName: string,
) {
  const ownerAuthority = parseManagedPostgresUrl(ownerRaw, databaseName);
  const runtimeAuthority = parseManagedPostgresUrl(runtimeRaw, databaseName);
  const owner = new URL(ownerRaw);
  const runtime = new URL(runtimeRaw);
  if (
    ownerAuthority.hostSha256 !== runtimeAuthority.hostSha256 ||
    ownerAuthority.port !== runtimeAuthority.port ||
    decodeURIComponent(runtime.username) !== roleName ||
    decodeURIComponent(owner.username) === roleName ||
    decodeURIComponent(owner.username) === decodeURIComponent(runtime.username) ||
    decodeURIComponent(owner.password) === decodeURIComponent(runtime.password)
  ) {
    throw new Error('managed owner/runtime voice upgrade authorities are not split on one database');
  }
  return { ownerAuthority, runtimeAuthority };
}

export function buildManagedVoiceUpgradeValidation(
  ownerRaw: string,
  runtimeRaw: string,
  databaseName: string,
  roleName: string,
) {
  const { ownerAuthority } = assertManagedVoiceUpgradeUrls(ownerRaw, runtimeRaw, databaseName, roleName);
  return {
    databaseName,
    hostSha256: ownerAuthority.hostSha256,
    port: ownerAuthority.port,
    roleSha256: createHash('sha256').update(roleName).digest('hex'),
    validation: 'managed-owner-runtime-authority-split',
  };
}

async function main(args: readonly string[]) {
  const ownerDatabaseUrl = process.env.MANAGED_OWNER_DATABASE_URL;
  const runtimeDatabaseUrl = process.env.MANAGED_DATABASE_URL;
  const databaseName = process.env.MANAGED_DATABASE_EXPECTED_NAME;
  const roleName = process.env.MANAGED_RUNTIME_ROLE;
  if (!ownerDatabaseUrl || !runtimeDatabaseUrl || !databaseName || !roleName) {
    throw new Error('managed runtime voice upgrade environment is incomplete');
  }
  const validation = buildManagedVoiceUpgradeValidation(
    ownerDatabaseUrl,
    runtimeDatabaseUrl,
    databaseName,
    roleName,
  );
  if (args.length === 1 && args[0] === '--validate-only') return validation;
  if (args.length !== 0) throw new Error('managed runtime voice upgrade arguments are invalid');
  const client = postgres(ownerDatabaseUrl, {
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
  } finally {
    await client.end({ timeout: 5 });
  }
  const runtime = postgres(runtimeDatabaseUrl, {
    max: 1,
    ssl: 'verify-full',
    connect_timeout: 10,
    idle_timeout: 1,
    onnotice: () => {},
  });
  try {
    const [proof] = await runtime`
      select current_database()::text as "databaseName",
        current_user::text as "roleName",
        has_function_privilege(
          current_user,
          'public.account_erasure_assert_voice_output_writable(text)',
          'EXECUTE'
        ) as granted
    ` as readonly [{ databaseName: string; roleName: string; granted: boolean }];
    if (proof?.databaseName !== databaseName || proof.roleName !== roleName || proof.granted !== true) {
      throw new Error('managed runtime voice privilege was not visible through the runtime credential');
    }
    return {
      databaseName,
      roleSha256: createHash('sha256').update(roleName).digest('hex'),
      privilege: 'account_erasure_assert_voice_output_writable(text):EXECUTE',
    };
  } finally {
    await runtime.end({ timeout: 5 });
  }
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
  main(process.argv.slice(2))
    .then((evidence) => console.log(JSON.stringify({ ok: true, evidence })))
    .catch(() => {
      console.error(JSON.stringify({ ok: false, error: 'managed_runtime_voice_upgrade_failed' }));
      process.exitCode = 1;
    });
}
