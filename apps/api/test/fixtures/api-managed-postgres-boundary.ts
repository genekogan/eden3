import { parseManagedPostgresUrl } from '@eden3/db/managed-postgres-preflight';

const REHEARSAL_DATABASE = /^eden3_managed_rehearsal(?:_[a-z0-9]{4,32})?$/;

export function assertApiManagedPostgresBoundary(
  environment: Record<string, string | undefined>,
): string {
  const databaseUrl = environment.MANAGED_DATABASE_URL;
  const databaseName = environment.MANAGED_DATABASE_EXPECTED_NAME;
  if (
    environment.EDEN3_MANAGED_POSTGRES_TESTS !== '1' ||
    !databaseUrl ||
    !databaseName ||
    !REHEARSAL_DATABASE.test(databaseName) ||
    (environment.DATABASE_URL !== undefined && environment.DATABASE_URL !== databaseUrl)
  ) {
    throw new Error('API managed PostgreSQL tests require the exact disposable rehearsal database');
  }
  const runtimeAuthority = parseManagedPostgresUrl(databaseUrl, databaseName);
  if (environment.MANAGED_OWNER_DATABASE_URL) {
    const ownerAuthority = parseManagedPostgresUrl(environment.MANAGED_OWNER_DATABASE_URL, databaseName);
    const runtimeUrl = new URL(databaseUrl);
    const ownerUrl = new URL(environment.MANAGED_OWNER_DATABASE_URL);
    if (
      ownerAuthority.hostSha256 !== runtimeAuthority.hostSha256 ||
      ownerAuthority.port !== runtimeAuthority.port ||
      ownerUrl.username === runtimeUrl.username
    ) {
      throw new Error('managed PostgreSQL owner and runtime credentials must be distinct');
    }
  }
  environment.DATABASE_URL = databaseUrl;
  return databaseName;
}
