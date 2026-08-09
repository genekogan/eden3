import { databaseNameFromUrl, hasLiteralPostgresEndpoint } from '../../src/database-url';

const CORE_TEST_SCRATCH = /^eden3_core_pg_[a-f0-9]{8}$/;
const REFUSAL = 'Core tests require a local disposable database';
export const CORE_TEST_DATABASE_SENTINEL =
  'postgres://127.0.0.1:1/eden3_core_unit_unreachable';

export function isCoreVitestConfigName(name: string): boolean {
  return name.startsWith('vitest') && name.endsWith('.config.ts');
}

export function assertCoreTestDatabaseBoundary(
  environment: Record<string, string | undefined>,
  options: { required: boolean } = { required: false },
): string | undefined {
  const databaseUrl = environment.DATABASE_URL;
  if (databaseUrl === undefined) {
    if (options.required) throw new Error(REFUSAL);
    environment.DATABASE_URL = CORE_TEST_DATABASE_SENTINEL;
    return undefined;
  }
  if (!options.required && databaseUrl === CORE_TEST_DATABASE_SENTINEL) return undefined;
  const databaseName = databaseNameFromUrl(databaseUrl);
  const local = hasLiteralPostgresEndpoint(databaseUrl, '127.0.0.1', 5433) ||
    hasLiteralPostgresEndpoint(databaseUrl, 'localhost', 5433);
  if (!databaseName || !local || !CORE_TEST_SCRATCH.test(databaseName)) {
    throw new Error(REFUSAL);
  }
  return databaseName;
}
