import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { AuthSession } from '@eden3/core';
import { describe, expect, it, vi } from 'vitest';

import {
  AUTHORIZATION_CHECK_TIMEOUT_MS,
  KEEPALIVE_INTERVAL_MS,
  SESSION_EVENT_AUTHORIZATION_LEASE_MS,
  SessionEventAuthorizationLease,
  sessionEventAccessStillValid,
} from '../src/events-bus';

const ACCOUNT_ID = randomUUID();
const SESSION_ID = randomUUID();
const ACCOUNT: AuthSession = {
  accountId: ACCOUNT_ID,
  username: 'member',
  isAdmin: false,
};

function accessCheck(overrides: {
  account?: AuthSession | null;
  session?: { id: string } | null;
  access?: boolean;
} = {}) {
  const account = 'account' in overrides ? overrides.account : ACCOUNT;
  const session = 'session' in overrides ? overrides.session : { id: SESSION_ID };
  const access = overrides.access ?? true;
  return {
    expectedAccountId: ACCOUNT_ID,
    expectedSessionId: SESSION_ID,
    getSession: vi.fn(async () => account ?? null),
    resolveSession: vi.fn(async () => session ?? null),
    canAccess: vi.fn(async () => access),
  };
}

describe('session event stream reauthorization', () => {
  it('requires the current token to resolve to the exact admitting account', async () => {
    const expired = accessCheck({ account: null });
    expect(await sessionEventAccessStillValid(expired)).toBe(false);
    expect(expired.resolveSession).not.toHaveBeenCalled();

    const switched = accessCheck({ account: { ...ACCOUNT, accountId: randomUUID() } });
    expect(await sessionEventAccessStillValid(switched)).toBe(false);
    expect(switched.resolveSession).not.toHaveBeenCalled();
  });

  it('requires the same canonical session and current access on every check', async () => {
    const missing = accessCheck({ session: null });
    expect(await sessionEventAccessStillValid(missing)).toBe(false);
    expect(missing.canAccess).not.toHaveBeenCalled();

    const replaced = accessCheck({ session: { id: randomUUID() } });
    expect(await sessionEventAccessStillValid(replaced)).toBe(false);
    expect(replaced.canAccess).not.toHaveBeenCalled();

    const revoked = accessCheck({ access: false });
    expect(await sessionEventAccessStillValid(revoked)).toBe(false);
    expect(revoked.canAccess).toHaveBeenCalledWith({ id: SESSION_ID }, ACCOUNT);

    const current = accessCheck();
    expect(await sessionEventAccessStillValid(current)).toBe(true);
    expect(current.canAccess).toHaveBeenCalledWith({ id: SESSION_ID }, ACCOUNT);
  });

  it('closes once on denial or verifier failure and never checks or pings again', async () => {
    const denied = vi.fn(async () => false);
    const ping = vi.fn();
    const close = vi.fn();
    const lease = new SessionEventAuthorizationLease(denied, ping, close);

    await lease.reauthorize();
    await lease.reauthorize();
    expect(denied).toHaveBeenCalledTimes(1);
    expect(ping).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);

    const failingClose = vi.fn(() => {
      throw new Error('socket already closed');
    });
    const failed = new SessionEventAuthorizationLease(
      async () => {
        throw new Error('auth backend unavailable');
      },
      ping,
      failingClose,
    );
    await expect(failed.reauthorize()).resolves.toBeUndefined();
    await failed.reauthorize();
    expect(failingClose).toHaveBeenCalledTimes(1);
  });

  it('keeps successful checks single-flight and stops cleanly', async () => {
    let release!: (allowed: boolean) => void;
    const check = vi.fn(
      () => new Promise<boolean>((resolve) => {
        release = resolve;
      }),
    );
    const ping = vi.fn();
    const close = vi.fn();
    const lease = new SessionEventAuthorizationLease(check, ping, close);

    const first = lease.reauthorize();
    await lease.reauthorize();
    expect(check).toHaveBeenCalledTimes(1);
    release(true);
    await first;
    expect(ping).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();

    lease.stop();
    await lease.reauthorize();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('releases a pending reauthorization when the socket-side lease stops', async () => {
    const check = vi.fn(() => new Promise<boolean>(() => {}));
    const ping = vi.fn();
    const close = vi.fn();
    const lease = new SessionEventAuthorizationLease(check, ping, close);

    const pending = lease.reauthorize();
    await Promise.resolve();
    lease.stop();
    await expect(pending).resolves.toBeUndefined();
    expect(check).toHaveBeenCalledTimes(1);
    expect(ping).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('denies a never-settling verifier at the absolute deadline without revival', async () => {
    vi.useFakeTimers();
    try {
      let rejectLate!: (error: Error) => void;
      const check = vi.fn(
        () => new Promise<boolean>((_resolve, reject) => {
          rejectLate = reject;
        }),
      );
      const ping = vi.fn();
      const close = vi.fn();
      const lease = new SessionEventAuthorizationLease(check, ping, close, 100);

      const pending = lease.reauthorize();
      await vi.advanceTimersByTimeAsync(99);
      expect(close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(close).toHaveBeenCalledTimes(1);
      expect(ping).not.toHaveBeenCalled();

      rejectLate(new Error('late verifier failure'));
      await Promise.resolve();
      await lease.reauthorize();
      expect(check).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(ping).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('wires the route lease to current auth, account, session, and access authority', () => {
    const source = readFileSync(new URL('../src/events-bus.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/setInterval\(\(\) => \{\s*void authorizationLease\.reauthorize\(\)/);
    expect(source).toContain('getSession: () => app.authProvider.getSession(req)');
    expect(source).toContain('expectedAccountId: account.accountId');
    expect(source).toContain('expectedSessionId: sessionId');
    expect(source).toContain('resolveSession: () => resolveSession(sessionId)');
    expect(source).toContain('canAccess: canAccessSession');
    expect(source).toMatch(/const terminate = \(\) => \{\s*authorizationLease\?\.stop\(\);\s*cleanup\(\)/);
    expect(source).toContain('keepaliveIntervalMs > KEEPALIVE_INTERVAL_MS');
    expect(source).toContain("reply.raw.on('error', terminate)");
    expect(AUTHORIZATION_CHECK_TIMEOUT_MS).toBeGreaterThan(0);
    expect(KEEPALIVE_INTERVAL_MS + AUTHORIZATION_CHECK_TIMEOUT_MS).toBeLessThanOrEqual(
      SESSION_EVENT_AUTHORIZATION_LEASE_MS,
    );
  });
});
