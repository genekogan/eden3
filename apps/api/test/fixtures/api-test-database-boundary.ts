import {
  databaseNameFromUrl,
  hasLiteralPostgresEndpoint,
} from '@eden3/core/database-url';

const API_TEST_SCRATCH = /^(?:eden3_[a-z0-9_]{12,80}|t[0-9][a-z0-9_]{14,80}|debt[0-9][a-z0-9_]{14,80})$/;
const REFUSAL = 'API tests require a local disposable database';
export const API_TEST_DATABASE_SENTINEL =
  'postgres://127.0.0.1:1/eden3_api_unit_unreachable';

export type ApiPostgresEvidenceFlag =
  | 'EDEN3_AGENT_PROVISION_NOTIFICATION_PG'
  | 'EDEN3_E2E_FIXTURE_PG';

export function assertApiPostgresEvidenceFlag(
  environment: Record<string, string | undefined>,
  flag: ApiPostgresEvidenceFlag,
): void {
  if (environment[flag] !== '1') {
    throw new Error('API PostgreSQL proof requires its explicit evidence flag');
  }
}

export function isApiVitestConfigName(name: string): boolean {
  return name.startsWith('vitest') && name.endsWith('.config.ts');
}

export function assertApiTestDatabaseBoundary(
  environment: Record<string, string | undefined>,
  options: { required: boolean } = { required: false },
): string | undefined {
  const databaseUrl = environment.DATABASE_URL;
  if (databaseUrl === undefined) {
    if (options.required) throw new Error(REFUSAL);
    environment.DATABASE_URL = API_TEST_DATABASE_SENTINEL;
    return undefined;
  }
  if (!options.required && databaseUrl === API_TEST_DATABASE_SENTINEL) return undefined;
  const databaseName = databaseNameFromUrl(databaseUrl);
  const local = hasLiteralPostgresEndpoint(databaseUrl, '127.0.0.1', 5433) ||
    hasLiteralPostgresEndpoint(databaseUrl, 'localhost', 5433);
  if (!databaseName || !local || !API_TEST_SCRATCH.test(databaseName)) {
    throw new Error(REFUSAL);
  }
  return databaseName;
}
