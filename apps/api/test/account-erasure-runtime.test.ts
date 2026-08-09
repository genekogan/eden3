import type { PgClient } from '@eden3/db';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { attestAccountErasureDatabaseBoundary } from '../src/services/account-erasure-postgres';
import { buildServer } from '../src/server';

import {
  accountErasureIntervalMs,
  assertAccountErasureRuntimeComposition,
  assertAccountErasureRuntimeDatabaseIdentity,
  createAccountErasureRuntimeBundle,
  maybeStartAccountErasureBackgroundLoop,
  registerAccountErasureBackgroundLifecycle,
  startAccountErasureBackgroundLoop,
} from '../src/services/account-erasure-runtime';

describe('account erasure background runtime', () => {
  it('runs recovery then targets immediately and emits attention metrics', async () => {
    const calls: string[] = [];
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const loop = await startAccountErasureBackgroundLoop({
      recoveryWorker: {
        tick: async () => {
          calls.push('recovery');
          return {
            claimed: 1, sealed: 1, retried: 0, attention: 0, stale: 0,
            wormOverdue: 0, targetOverdue: 0,
          };
        },
      },
      targetWorker: {
        tick: async () => {
          calls.push('targets');
          return { claimed: 1, completed: 0, retried: 1, attention: 0, stale: 0 };
        },
      },
      intervalMs: 60_000,
      logger,
      schedule: vi.fn(() => ({ unref: vi.fn() }) as unknown as ReturnType<typeof setInterval>),
      cancel: vi.fn(),
    });

    expect(calls).toEqual(['recovery', 'targets']);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      accountErasure: expect.objectContaining({ targets: expect.objectContaining({ retried: 1 }) }),
    }), 'account erasure tick requires attention');
    await loop.stop();
  });

  it('fails closed on timer overflow and invalid text', () => {
    expect(accountErasureIntervalMs({ ACCOUNT_ERASURE_INTERVAL_MS: '2147483647' })).toBe(2_147_483_647);
    expect(() => accountErasureIntervalMs({ ACCOUNT_ERASURE_INTERVAL_MS: '2147483648' })).toThrow();
    expect(() => accountErasureIntervalMs({ ACCOUNT_ERASURE_INTERVAL_MS: '10ms' })).toThrow();
    expect(() => accountErasureIntervalMs({ ACCOUNT_ERASURE_INTERVAL_MS: '0' })).toThrow();
  });

  it('does not touch either worker or schedule when auto-start is disabled', async () => {
    const recoveryTick = vi.fn();
    const targetTick = vi.fn();
    const schedule = vi.fn();
    await expect(maybeStartAccountErasureBackgroundLoop({
      autoStart: false,
      recoveryWorker: { tick: recoveryTick },
      targetWorker: { tick: targetTick },
      intervalMs: 60_000,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      schedule,
    })).resolves.toBeNull();
    expect(recoveryTick).not.toHaveBeenCalled();
    expect(targetTick).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it('does not start when a later Fastify registration fails', async () => {
    const app = Fastify();
    const recoveryTick = vi.fn(async () => ({
      claimed: 0, sealed: 0, retried: 0, attention: 0, stale: 0,
      wormOverdue: 0, targetOverdue: 0,
    }));
    const targetTick = vi.fn(async () => ({
      claimed: 0, completed: 0, retried: 0, attention: 0, stale: 0,
    }));
    const schedule = vi.fn(() => ({ unref: vi.fn() }) as unknown as ReturnType<typeof setInterval>);
    registerAccountErasureBackgroundLifecycle(app, {
      autoStart: true,
      recoveryWorker: { tick: recoveryTick },
      targetWorker: { tick: targetTick },
      intervalMs: 60_000,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      schedule,
      cancel: vi.fn(),
    });
    app.register(async () => { throw new Error('late registration failure'); });
    await expect(app.ready()).rejects.toThrow('late registration failure');
    expect(recoveryTick).not.toHaveBeenCalled();
    expect(targetTick).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
    await app.close();
  });

  it('starts once at readiness and awaits an in-flight tick on shutdown', async () => {
    const app = Fastify();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let scheduled!: () => void;
    const recoveryTick = vi.fn(async () => {
      if (recoveryTick.mock.calls.length === 2) await held;
      return {
        claimed: 0, sealed: 0, retried: 0, attention: 0, stale: 0,
        wormOverdue: 0, targetOverdue: 0,
      };
    });
    const targetTick = vi.fn(async () => ({
      claimed: 0, completed: 0, retried: 0, attention: 0, stale: 0,
    }));
    const cancel = vi.fn();
    const schedule = vi.fn((callback: () => void) => {
      scheduled = callback;
      return { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
    });
    registerAccountErasureBackgroundLifecycle(app, {
      autoStart: true,
      recoveryWorker: { tick: recoveryTick },
      targetWorker: { tick: targetTick },
      intervalMs: 60_000,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      schedule,
      cancel,
    });

    await app.ready();
    await app.ready();
    expect(recoveryTick).toHaveBeenCalledTimes(1);
    expect(targetTick).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledTimes(1);
    scheduled();
    await vi.waitFor(() => expect(recoveryTick).toHaveBeenCalledTimes(2));
    let closed = false;
    const close = app.close().then(() => { closed = true; });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(closed).toBe(false);
    release();
    await close;
    expect(targetTick).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('refuses production route composition without the mandatory loop', async () => {
    expect(() => assertAccountErasureRuntimeComposition(undefined)).not.toThrow();
    const attestationClient = (async (strings: TemplateStringsArray) => {
      if (strings.join('?').includes('pg_has_role(session_user')) return [{
        database_name: 'scratch', database_oid: '4242', session_user: 'eden3_erasure_test',
        operator_member: true, operator_login: true, operator_superuser: false,
        operator_create_role: false, operator_bypass_rls: false, operator_replication: false,
      }];
      return [];
    }) as unknown as PgClient;
    const ordinaryApplicationClient = (async () => [{
      database_name: 'scratch', database_oid: '4242', session_user: 'eden3_app_test',
      operator_member: false, terminal_writer_member: true,
    }]) as unknown as PgClient;
    const ordinaryApplicationDb = { execute: async () => [{
      database_name: 'scratch', database_oid: '4242', session_user: 'eden3_app_test',
      operator_member: false, terminal_writer_member: true,
    }] } as never;
    const databaseBoundary = await attestAccountErasureDatabaseBoundary({
      operatorClient: attestationClient,
      ordinaryApplicationClient,
      ordinaryApplicationDb,
      operatorLogin: 'eden3_erasure_test',
      ordinaryApplicationLogin: 'eden3_app_test',
    });
    const claimIntentForRecovery = vi.fn();
    const store = {
      databaseBoundary,
      claimLeaseMs: 60_000,
      claimIntentForRecovery,
    } as never;
    const targetStore = {
      databaseBoundary,
      claimLeaseMs: 60_000,
      claimTarget: vi.fn(),
      completeTarget: vi.fn(),
      failTarget: vi.fn(),
    };
    const bundle = createAccountErasureRuntimeBundle({
      store,
      ledger: { writeAndConfirm: vi.fn() },
      recoveryManifestSink: { encryptWriteAndConfirm: vi.fn() },
      targetStore,
      targetExecutor: { erase: vi.fn() },
      ledgerCustodyId: 'erasure-ledger-worm',
      recoveryManifestCustodyId: 'erasure-recovery-encrypted',
    });
    expect(() => assertAccountErasureRuntimeComposition(bundle)).not.toThrow();
    expect(() => assertAccountErasureRuntimeDatabaseIdentity(undefined, {
      db: { execute: vi.fn() } as never,
      pg: (() => []) as never,
    })).not.toThrow();
    expect(() => assertAccountErasureRuntimeDatabaseIdentity(bundle, {
      db: databaseBoundary.ordinaryApplicationDb,
      pg: ordinaryApplicationClient,
    })).not.toThrow();
    expect(() => assertAccountErasureRuntimeDatabaseIdentity(bundle, {
      db: { execute: vi.fn() } as never,
      pg: ordinaryApplicationClient,
    })).toThrow('does not match the running application database');
    await expect(buildServer({ accountErasure: bundle })).rejects.toThrow(
      'does not match the running application database',
    );
    expect(claimIntentForRecovery).not.toHaveBeenCalled();
    expect(targetStore.claimTarget).not.toHaveBeenCalled();
    expect(() => assertAccountErasureRuntimeDatabaseIdentity(bundle, {
      db: databaseBoundary.ordinaryApplicationDb,
      pg: (() => []) as never,
    })).toThrow('does not match the running application database');
    expect(() => assertAccountErasureRuntimeComposition({ autoStart: false } as never)).toThrow(
      'requires its mandatory recovery and target worker loop',
    );
    expect(() => createAccountErasureRuntimeBundle({
      store,
      ledger: { writeAndConfirm: vi.fn() },
      recoveryManifestSink: { encryptWriteAndConfirm: vi.fn() },
      targetStore,
      targetExecutor: { erase: vi.fn() },
      ledgerCustodyId: 'same-custody',
      recoveryManifestCustodyId: 'same-custody',
    })).toThrow('distinct custody identities');
    const mismatchedBoundary = await attestAccountErasureDatabaseBoundary({
      operatorClient: attestationClient,
      ordinaryApplicationClient: (async () => [{
          database_name: 'scratch', database_oid: '4242', session_user: 'eden3_other_app',
          operator_member: false, terminal_writer_member: true,
      }]) as unknown as PgClient,
      ordinaryApplicationDb: { execute: async () => [{
        database_name: 'scratch', database_oid: '4242', session_user: 'eden3_other_app',
        operator_member: false, terminal_writer_member: true,
      }] } as never,
      operatorLogin: 'eden3_erasure_test',
      ordinaryApplicationLogin: 'eden3_other_app',
    });
    expect(() => createAccountErasureRuntimeBundle({
      store,
      ledger: { writeAndConfirm: vi.fn() },
      recoveryManifestSink: { encryptWriteAndConfirm: vi.fn() },
      targetStore: { ...targetStore, databaseBoundary: mismatchedBoundary },
      targetExecutor: { erase: vi.fn() },
      ledgerCustodyId: 'erasure-ledger-worm',
      recoveryManifestCustodyId: 'erasure-recovery-encrypted',
    })).toThrow('one attested operator database boundary');
  });
});
