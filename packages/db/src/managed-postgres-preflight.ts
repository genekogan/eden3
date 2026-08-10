import { createHash } from 'node:crypto';

export interface ManagedPostgresAuthority {
  databaseName: string;
  port: number;
  hostSha256: string;
  tlsMode: 'verify-full';
}

export interface ManagedPostgresEvidence extends ManagedPostgresAuthority {
  serverVersion: string;
  serverVersionNum: number;
  maxConnections: number;
  inRecovery: boolean;
  transactionReadOnly: true;
  migrationCount: number;
  latestMigrationId: number;
}

const DATABASE_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,62}$/;

export function parseManagedPostgresUrl(
  raw: string,
  expectedDatabaseName: string,
): ManagedPostgresAuthority {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('managed PostgreSQL URL is invalid');
  }
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const port = url.port === '' ? 5432 : Number(url.port);
  const queryKeys = [...url.searchParams.keys()];
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.username ||
    !url.password ||
    !url.hostname.includes('.') ||
    /^\d+(?:\.\d+){3}$/.test(url.hostname) ||
    url.hostname.includes(':') ||
    ['localhost', 'host.docker.internal'].includes(url.hostname.toLowerCase()) ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535 ||
    url.pathname !== `/${databaseName}` ||
    !DATABASE_NAME.test(databaseName) ||
    url.hash !== '' ||
    queryKeys.length !== 1 ||
    queryKeys[0] !== 'sslmode' ||
    url.searchParams.get('sslmode') !== 'verify-full' ||
    !DATABASE_NAME.test(expectedDatabaseName) ||
    databaseName !== expectedDatabaseName
  ) {
    throw new Error('managed PostgreSQL URL must be an exact credentialed TLS verify-full database');
  }
  return {
    databaseName,
    port,
    hostSha256: createHash('sha256').update(url.hostname.toLowerCase()).digest('hex'),
    tlsMode: 'verify-full',
  };
}

interface ReadOnlySql {
  (strings: TemplateStringsArray, ...parameters: unknown[]): unknown;
}

async function awaitRows<T extends readonly object[]>(query: unknown): Promise<T> {
  return await (query as PromiseLike<T>);
}

export async function inspectManagedPostgres(
  sql: ReadOnlySql,
  authority: ManagedPostgresAuthority,
): Promise<ManagedPostgresEvidence> {
  const [identity] = await awaitRows<{
    databaseName: string;
    serverVersion: string;
    serverVersionNum: string;
    maxConnections: string;
    inRecovery: boolean;
    transactionReadOnly: string;
  }[]>(sql`
    select current_database()::text as "databaseName",
           current_setting('server_version')::text as "serverVersion",
           current_setting('server_version_num')::text as "serverVersionNum",
           current_setting('max_connections')::text as "maxConnections",
           pg_is_in_recovery() as "inRecovery",
           current_setting('transaction_read_only')::text as "transactionReadOnly"
  `);
  const [migrations] = await awaitRows<{ migrationCount: number; latestMigrationId: number | null }[]>(sql`
    select count(*)::int as "migrationCount", max(id)::int as "latestMigrationId"
    from drizzle.__drizzle_migrations
  `);
  const serverVersionNum = Number(identity?.serverVersionNum);
  const maxConnections = Number(identity?.maxConnections);
  const migrationCount = migrations?.migrationCount;
  const latestMigrationId = migrations?.latestMigrationId;
  if (
    identity?.databaseName !== authority.databaseName ||
    identity.transactionReadOnly !== 'on' ||
    identity.inRecovery !== false ||
    !Number.isSafeInteger(serverVersionNum) ||
    serverVersionNum < 160000 ||
    !Number.isSafeInteger(maxConnections) ||
    maxConnections < 10 ||
    !Number.isSafeInteger(migrationCount) ||
    migrationCount! < 1 ||
    !Number.isSafeInteger(latestMigrationId) ||
    latestMigrationId! < 1
  ) {
    throw new Error('managed PostgreSQL read-only preflight did not meet the exact database contract');
  }
  return {
    ...authority,
    serverVersion: identity.serverVersion,
    serverVersionNum,
    maxConnections,
    inRecovery: identity.inRecovery,
    transactionReadOnly: true,
    migrationCount: migrationCount!,
    latestMigrationId: latestMigrationId!,
  };
}
