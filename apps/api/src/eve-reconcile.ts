import { parseArgs as parseNodeArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

import type { EveReconciliationInput } from './services/eve-reconciliation';

const VALUE_OPTIONS = [
  'expected-database-name',
  'expected-collision-account-id',
  'expected-collision-owner-id',
  'expected-collision-openclaw-id',
  'expected-collision-handle',
  'expected-platform-account-id',
  'expected-platform-openclaw-id',
  'expected-platform-handle',
  'new-handle',
] as const;

export interface EveReconciliationCliOptions {
  input: EveReconciliationInput;
  apply: boolean;
}

export function parseEveReconciliationArgs(argv: string[]): EveReconciliationCliOptions {
  const normalizedArgv = argv[0] === '--' ? argv.slice(1) : argv;
  const parsed = parseNodeArgs({
    args: normalizedArgv,
    allowPositionals: false,
    strict: true,
    options: {
      'expected-database-name': { type: 'string' },
      'expected-collision-account-id': { type: 'string' },
      'expected-collision-owner-id': { type: 'string' },
      'expected-collision-openclaw-id': { type: 'string' },
      'expected-collision-handle': { type: 'string' },
      'expected-platform-account-id': { type: 'string' },
      'expected-platform-openclaw-id': { type: 'string' },
      'expected-platform-handle': { type: 'string' },
      'new-handle': { type: 'string' },
      apply: { type: 'boolean', default: false },
    },
  });
  for (const option of VALUE_OPTIONS) {
    if (typeof parsed.values[option] !== 'string' || parsed.values[option]!.trim() === '') {
      throw new Error(`Missing required --${option}`);
    }
  }
  return {
    apply: parsed.values.apply ?? false,
    input: {
      expectedDatabaseName: parsed.values['expected-database-name']!,
      expectedCollisionAccountId: parsed.values['expected-collision-account-id']!,
      expectedCollisionOwnerId: parsed.values['expected-collision-owner-id']!,
      expectedCollisionOpenclawId: parsed.values['expected-collision-openclaw-id']!,
      expectedCollisionHandle: parsed.values['expected-collision-handle']!,
      expectedPlatformAccountId: parsed.values['expected-platform-account-id']!,
      expectedPlatformOpenclawId: parsed.values['expected-platform-openclaw-id']!,
      expectedPlatformHandle: parsed.values['expected-platform-handle']!,
      newHandle: parsed.values['new-handle']!,
    },
  };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let pg: typeof import('@eden3/db').pg | undefined;
  try {
    const cli = parseEveReconciliationArgs(argv);
    const [service, database] = await Promise.all([
      import('./services/eve-reconciliation'),
      import('@eden3/db'),
    ]);
    pg = database.pg;
    const result = await service.reconcileEveCollision(cli.input, { apply: cli.apply });
    process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
    return 0;
  } catch (error) {
    const candidate = error as {
      code?: unknown;
      message?: unknown;
      safeDetails?: unknown;
    };
    const code = typeof candidate.code === 'string' ? candidate.code : 'invalid_invocation';
    const message = typeof candidate.message === 'string' ? candidate.message : 'Eve reconciliation failed';
    process.stderr.write(
      `${JSON.stringify({
        ok: false,
        error: {
          code,
          message,
          ...(candidate.safeDetails && typeof candidate.safeDetails === 'object'
            ? { details: candidate.safeDetails }
            : {}),
        },
      }, null, 2)}\n`,
    );
    return code === 'bootstrap_pending' ? 2 : 1;
  } finally {
    await pg?.end({ timeout: 5 });
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  process.exitCode = await main();
}
