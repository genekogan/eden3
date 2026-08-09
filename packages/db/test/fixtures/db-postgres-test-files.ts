import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DB_SCRATCH_INTEGRATION_FILES = [
  'test/integration/account-erasure-lifecycle.itest.ts',
  'test/integration/catalog-advisory-lock.itest.ts',
  'test/integration/netspend-index.itest.ts',
  'test/integration/storage-kernel.itest.ts',
  'test/integration/storage-local-backend.itest.ts',
  'test/integration/turn-authorizations.itest.ts',
  'test/integration/upload-policy-events.itest.ts',
] as const;

export const DB_PROTECTED_READONLY_FILES = [
  'test/integration/netspend-index-readonly.itest.ts',
] as const;

export const DB_ALL_POSTGRES_TEST_FILES = [
  ...DB_SCRATCH_INTEGRATION_FILES,
  ...DB_PROTECTED_READONLY_FILES,
].sort();

const COMMAND_WORDS = new Set(['run', 'watch', 'related', 'vitest']);
const DB_PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const REPOSITORY_ROOT = path.resolve(DB_PACKAGE_ROOT, '../..');

function absoluteCandidates(selector: string): string[] {
  if (path.isAbsolute(selector)) return [path.normalize(selector)];
  return [
    path.resolve(process.cwd(), selector),
    path.resolve(DB_PACKAGE_ROOT, selector),
    path.resolve(REPOSITORY_ROOT, selector),
  ];
}

export function unitSelectorMatchesDbPostgresFile(rawSelector: string, file: string): boolean {
  const selector = rawSelector.replaceAll('\\', '/');
  const absoluteFile = path.resolve(DB_PACKAGE_ROOT, file);
  if (
    file.includes(selector) ||
    selector.endsWith(`/${file}`) ||
    selector.endsWith(`/${file.slice('test/integration/'.length)}`)
  ) {
    return true;
  }
  return absoluteCandidates(selector).some((candidate) =>
    absoluteFile === candidate || absoluteFile.startsWith(`${candidate}${path.sep}`));
}

export function dbPostgresFilesMatchingUnitSelector(argv: readonly string[]): string[] {
  const matches = new Set<string>();
  for (const raw of argv) {
    if (raw.startsWith('-') || COMMAND_WORDS.has(raw)) continue;
    for (const file of DB_ALL_POSTGRES_TEST_FILES) {
      if (unitSelectorMatchesDbPostgresFile(raw, file)) matches.add(file);
    }
  }
  return [...matches];
}

export function dbPostgresFileMatchingUnitSelector(argv: readonly string[]): string | undefined {
  return dbPostgresFilesMatchingUnitSelector(argv)[0];
}

export function assertDbUnitTestSelectors(argv: readonly string[]): void {
  const files = dbPostgresFilesMatchingUnitSelector(argv);
  if (files.length === 0) return;
  const includesReadonly = files.some((file) =>
    DB_PROTECTED_READONLY_FILES.some((entry) => entry === file));
  const includesScratch = files.some((file) =>
    DB_SCRATCH_INTEGRATION_FILES.some((entry) => entry === file));
  if (includesReadonly && includesScratch) {
    throw new Error(
      'Mixed DB selectors require separate `test:scratch-full` and separately authorized `test:catalog-readonly` commands',
    );
  }
  if (includesReadonly) {
    throw new Error(
      'Protected read-only DB tests require `test:catalog-readonly` with separate operator authorization',
    );
  }
  throw new Error(
    'Scratch PostgreSQL DB tests require `test:integration` or `test:scratch-full` with the exact disposable-database lease',
  );
}
