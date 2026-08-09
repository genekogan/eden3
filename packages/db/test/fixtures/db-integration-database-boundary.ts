import { localSourceDatabaseName } from './disposable-database';

const REFUSAL = 'DB integration tests require an explicit authorized local database target';

export type DbIntegrationMode = 'scratch' | 'protected-readonly';

export function assertDbIntegrationDatabaseBoundary(
  environment: Record<string, string | undefined>,
  mode: DbIntegrationMode,
): string {
  const raw = environment.DATABASE_URL;
  if (!raw) throw new Error(REFUSAL);
  let databaseName: string;
  try {
    databaseName = localSourceDatabaseName(raw);
  } catch {
    throw new Error(REFUSAL);
  }
  if (mode === 'scratch') {
    if (databaseName !== 'postgres') throw new Error(REFUSAL);
    return databaseName;
  }
  if (
    environment.EDEN3_DB_READONLY_AUDIT !== '1' ||
    (databaseName !== 'eden3' && databaseName !== 'eden3_stg')
  ) {
    throw new Error(REFUSAL);
  }
  return databaseName;
}
