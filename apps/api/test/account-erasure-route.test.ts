import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

import { requireAuth } from '../src/auth-plugin';
import { ApiError } from '../src/errors';
import { accountRoutes } from '../src/routes/account';
import type {
  AccountErasureIntentStore,
  AccountErasureLedgerSink,
  AccountErasureRecoveryManifestSink,
} from '../src/services/account-erasure';
import {
  accountErasureLedgerSha256,
  accountErasureManifestSha256,
} from '../src/services/account-erasure';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-08-08T20:00:00.000Z';
const HASH = 'a'.repeat(64);

function dependencies() {
  const store: AccountErasureIntentStore = {
    acceptIntent: vi.fn(async ({ accountId }) => ({
      jobId: JOB_ID,
      accountId,
      acceptedAt: NOW,
      state: 'intent_pending' as const,
    })),
    sealUnclaimedAfterLedgerConfirmation: vi.fn(async ({ accountId }) => ({
      jobId: JOB_ID,
      accountId,
      status: 'recovery_manifest_pending' as const,
      recoveryManifest: {
        schemaVersion: 'eden3.account-erasure-recovery@v1' as const,
        jobId: JOB_ID,
        accountId,
        inventoriedAt: NOW,
        inventorySha256: HASH,
        locators: [],
      },
    })),
    confirmRecoveryManifestUnclaimed: vi.fn(async () => ({ jobId: JOB_ID, status: 'pending' as const })),
  };
  const ledger: AccountErasureLedgerSink = {
    writeAndConfirm: vi.fn(async (record) => ({
      record,
      confirmedAt: NOW,
      sha256: accountErasureLedgerSha256(record),
      macSha256: HASH,
    })),
  };
  const recoveryManifestSink: AccountErasureRecoveryManifestSink = {
    encryptWriteAndConfirm: vi.fn(async (manifest) => ({
      schemaVersion: manifest.schemaVersion,
      jobId: manifest.jobId,
      accountId: manifest.accountId,
      inventorySha256: manifest.inventorySha256,
      manifestSha256: accountErasureManifestSha256(manifest),
      confirmedAt: NOW,
      ciphertextSha256: HASH,
      macSha256: HASH,
      keyVersion: 1,
    })),
  };
  return { store, ledger, recoveryManifestSink };
}

async function appFor(
  account: { accountId: string; username: string; isAdmin: boolean } | null,
  erasure = dependencies(),
) {
  const app = Fastify();
  app.decorateRequest('account', null);
  app.decorate('requireAuth', requireAuth);
  app.decorate('accessAllowlist', new Set<string>());
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) return reply.code(error.statusCode).send({ error: error.code });
    if (error instanceof ZodError) return reply.code(400).send({ error: 'validation_error' });
    return reply.code(500).send({ error: 'internal_error' });
  });
  app.addHook('onRequest', async (request) => {
    request.account = account;
  });
  await app.register(accountRoutes, { prefix: '/account', erasure });
  return { app, erasure };
}

describe('DELETE /account', () => {
  it('derives the only deletion target from the authenticated self', async () => {
    const { app, erasure } = await appFor({ accountId: ACCOUNT_ID, username: 'Alex', isAdmin: false });
    const response = await app.inject({
      method: 'DELETE',
      url: '/account',
      payload: { confirmUsername: 'alex' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ jobId: JOB_ID, status: 'pending' });
    expect(erasure.store.acceptIntent).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      confirmUsername: 'alex',
    });
    await app.close();
  });

  it('rejects anonymous/admin requests and caller-selected target fields', async () => {
    const anonymous = await appFor(null);
    expect((await anonymous.app.inject({ method: 'DELETE', url: '/account', payload: { confirmUsername: 'alex' } })).statusCode).toBe(401);
    await anonymous.app.close();

    const admin = await appFor({ accountId: ACCOUNT_ID, username: 'Alex', isAdmin: true });
    expect((await admin.app.inject({ method: 'DELETE', url: '/account', payload: { confirmUsername: 'alex' } })).statusCode).toBe(403);
    await admin.app.close();

    const selected = await appFor({ accountId: ACCOUNT_ID, username: 'Alex', isAdmin: false });
    expect((await selected.app.inject({
      method: 'DELETE',
      url: '/account',
      payload: { confirmUsername: 'alex', accountId: '33333333-3333-4333-8333-333333333333' },
    })).statusCode).toBe(400);
    expect(selected.erasure.store.acceptIntent).not.toHaveBeenCalled();
    await selected.app.close();
  });
});
