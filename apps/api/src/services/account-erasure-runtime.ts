import {
  AccountErasureRecoveryWorker,
  type AccountErasureLedgerSink,
  type AccountErasureRecoveryManifestSink,
  type AccountErasureRecoveryStore,
  type AccountErasureRecoveryTickResult,
} from './account-erasure';
import {
  AccountErasureTargetWorker,
  isAttestedAccountErasureDatabaseBoundary,
  type AccountErasureDatabaseBoundary,
  type AccountErasureTargetExecutor,
  type AccountErasureTargetStore,
  type AccountErasureTargetTickResult,
} from './account-erasure-postgres';
import type { DbHandle } from '@eden3/core';
import type { PgClient } from '@eden3/db';
import {
  MAX_NODE_INTERVAL_MS,
  startBackgroundWorkerLoop,
  type BackgroundWorkerLoop,
} from './background-worker-loop';

export interface AccountErasureLogger {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

export interface AccountErasureBackgroundLoopOptions {
  recoveryWorker: { tick(): Promise<AccountErasureRecoveryTickResult> };
  targetWorker: { tick(): Promise<AccountErasureTargetTickResult> };
  intervalMs: number;
  logger: AccountErasureLogger;
  schedule?: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>;
  cancel?: (timer: ReturnType<typeof setInterval>) => void;
}

export interface AccountErasureCombinedTickResult {
  recovery: AccountErasureRecoveryTickResult;
  targets: AccountErasureTargetTickResult;
}

const accountErasureBundle = Symbol('eden3.account-erasure-runtime-bundle');

/** One construction boundary makes route custody and both workers inseparable. */
export interface AccountErasureRuntimeBundle {
  readonly [accountErasureBundle]: true;
  readonly autoStart: true;
  readonly intervalMs?: number;
  readonly store: AccountErasureRecoveryStore;
  readonly ledger: AccountErasureLedgerSink;
  readonly recoveryManifestSink: AccountErasureRecoveryManifestSink;
  readonly recoveryWorker: AccountErasureRecoveryWorker;
  readonly targetWorker: AccountErasureTargetWorker;
  /** Attested ordinary-login handle for every provider admission/evidence write. */
  readonly providerEvidenceDb: DbHandle;
  readonly providerEvidenceClient: PgClient;
  readonly custody: {
    ledger: string;
    recoveryManifest: string;
  };
}

const custodyIdentity = /^[a-z][a-z0-9_-]{2,63}$/;

export function createAccountErasureRuntimeBundle(input: {
  store: AccountErasureRecoveryStore & { databaseBoundary: AccountErasureDatabaseBoundary };
  ledger: AccountErasureLedgerSink;
  recoveryManifestSink: AccountErasureRecoveryManifestSink;
  targetStore: AccountErasureTargetStore & { databaseBoundary: AccountErasureDatabaseBoundary };
  targetExecutor: AccountErasureTargetExecutor;
  ledgerCustodyId: string;
  recoveryManifestCustodyId: string;
  intervalMs?: number;
}): AccountErasureRuntimeBundle {
  if (!custodyIdentity.test(input.ledgerCustodyId) ||
      !custodyIdentity.test(input.recoveryManifestCustodyId) ||
      input.ledgerCustodyId === input.recoveryManifestCustodyId) {
    throw new Error('Account erasure ledger and recovery manifest require distinct custody identities');
  }
  if (!isAttestedAccountErasureDatabaseBoundary(input.store.databaseBoundary) ||
      !isAttestedAccountErasureDatabaseBoundary(input.targetStore.databaseBoundary) ||
      input.store.databaseBoundary !== input.targetStore.databaseBoundary) {
    throw new Error('Account erasure route, recovery, and target workers require one attested operator database boundary');
  }
  if (input.targetStore.legacyMediaBoundary !== undefined &&
      input.targetStore.legacyMediaBoundary !== input.targetExecutor.legacyMediaBoundary) {
    throw new Error('Account erasure target store and executor require one attested legacy media root');
  }
  if (input.targetExecutor.voiceCloneCustody !== true) {
    throw new Error('Account erasure requires confirmed Cartesia voice-clone absence custody');
  }
  const recoveryWorker = new AccountErasureRecoveryWorker(
    input.store,
    input.ledger,
    input.recoveryManifestSink,
    1,
    10_000,
  );
  const targetWorker = new AccountErasureTargetWorker(
    input.targetStore,
    input.targetExecutor,
    1,
    15_000,
  );
  return Object.freeze({
    [accountErasureBundle]: true as const,
    autoStart: true as const,
    ...(input.intervalMs === undefined ? {} : { intervalMs: input.intervalMs }),
    store: input.store,
    ledger: input.ledger,
    recoveryManifestSink: input.recoveryManifestSink,
    recoveryWorker,
    targetWorker,
    providerEvidenceDb: input.store.databaseBoundary.ordinaryApplicationDb,
    providerEvidenceClient: input.store.databaseBoundary.ordinaryApplicationClient,
    custody: Object.freeze({
      ledger: input.ledgerCustodyId,
      recoveryManifest: input.recoveryManifestCustodyId,
    }),
  });
}

function count(result: Record<string, number>, names: readonly string[]): number {
  return names.reduce((total, name) => total + (result[name] ?? 0), 0);
}

export function accountErasureIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ACCOUNT_ERASURE_INTERVAL_MS ?? '60000';
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`ACCOUNT_ERASURE_INTERVAL_MS must be an integer between 1 and ${MAX_NODE_INTERVAL_MS}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > MAX_NODE_INTERVAL_MS) {
    throw new Error(`ACCOUNT_ERASURE_INTERVAL_MS must be an integer between 1 and ${MAX_NODE_INTERVAL_MS}`);
  }
  return value;
}

/** Production must never expose admission without both mandatory workers. */
export function assertAccountErasureRuntimeComposition(
  options: AccountErasureRuntimeBundle | undefined,
): void {
  if (options && (options.autoStart !== true || options[accountErasureBundle] !== true)) {
    throw new Error('Account erasure route requires its mandatory recovery and target worker loop');
  }
}

/**
 * All legacy provider paths still import the shared @eden3/db handles. Bind
 * those exact objects to the attested ordinary login before any route or
 * background loop is registered; an unrelated-but-valid attestation is not
 * authority for this process.
 */
export function assertAccountErasureRuntimeDatabaseIdentity(
  options: AccountErasureRuntimeBundle | undefined,
  actual: { db: DbHandle; pg: PgClient },
): void {
  if (!options) return;
  if (options.providerEvidenceDb !== actual.db || options.providerEvidenceClient !== actual.pg) {
    throw new Error('Account erasure provider evidence database does not match the running application database');
  }
}

/**
 * One serialized account-erasure loop. Recovery always precedes target work,
 * so no target becomes eligible before both dedicated WORM confirmations.
 */
export async function startAccountErasureBackgroundLoop(
  options: AccountErasureBackgroundLoopOptions,
): Promise<BackgroundWorkerLoop> {
  return await startBackgroundWorkerLoop<AccountErasureCombinedTickResult>({
    intervalMs: options.intervalMs,
    schedule: options.schedule,
    cancel: options.cancel,
    tick: async () => ({
      recovery: await options.recoveryWorker.tick(),
      targets: await options.targetWorker.tick(),
    }),
    onResult: (result) => {
      const context = { accountErasure: result };
      const attention =
        count(result.recovery as unknown as Record<string, number>, [
          'retried', 'attention', 'stale', 'wormOverdue', 'targetOverdue',
        ]) +
        count(result.targets as unknown as Record<string, number>, ['retried', 'attention', 'stale']);
      const activity =
        attention +
        count(result.recovery as unknown as Record<string, number>, ['claimed', 'sealed']) +
        count(result.targets as unknown as Record<string, number>, ['claimed', 'completed']);
      if (attention > 0) options.logger.warn(context, 'account erasure tick requires attention');
      else if (activity > 0) options.logger.info(context, 'account erasure tick');
    },
    onError: (error) => options.logger.error({ err: error }, 'account erasure tick failed'),
  });
}

export async function maybeStartAccountErasureBackgroundLoop(
  options: AccountErasureBackgroundLoopOptions & { autoStart: boolean },
): Promise<BackgroundWorkerLoop | null> {
  if (!options.autoStart) return null;
  return await startAccountErasureBackgroundLoop(options);
}

export interface AccountErasureLifecycleHost {
  addHook(name: 'onReady', hook: () => Promise<void>): void;
  addHook(name: 'onClose', hook: () => Promise<void>): void;
}

/**
 * Arm destructive work only after Fastify has completed every registration.
 * If server construction fails, onReady is never entered and no tick/timer
 * exists. Shutdown waits for the one started loop, including its in-flight tick.
 */
export function registerAccountErasureBackgroundLifecycle(
  host: AccountErasureLifecycleHost,
  options: AccountErasureBackgroundLoopOptions & { autoStart: boolean },
): void {
  let loop: BackgroundWorkerLoop | null = null;
  let starting: Promise<void> | null = null;

  host.addHook('onReady', async () => {
    if (!options.autoStart || loop || starting) return;
    starting = (async () => {
      loop = await startAccountErasureBackgroundLoop(options);
    })();
    try {
      await starting;
    } finally {
      starting = null;
    }
  });
  host.addHook('onClose', async () => {
    await starting;
    await loop?.stop();
  });
}
