import { describe, expect, it } from 'vitest';

import type { AuthProvider } from '@eden3/core';

import { buildServer } from '../src/server';

/**
 * Closed-alpha access gate (DEPLOY-PLAN W1). When `accessAllowlist` is
 * non-empty every route 403s with `access_gated` for anonymous visitors and
 * non-listed accounts, except /health, /auth/*, /billing/webhook (and /dev/*
 * in dev mode). Empty allowlist = gate fully off (eden1-compat default).
 */

function providerFor(username: string | null): AuthProvider {
  return {
    async getSession() {
      if (!username) return null;
      return { accountId: '00000000-0000-4000-8000-000000000001', username, isAdmin: false };
    },
  };
}

describe('closed-alpha access gate', () => {
  it('stays fully open when the allowlist is empty', async () => {
    const app = await buildServer({
      gateway: null,
      auth: { provider: providerFor(null), accessAllowlist: [] },
    });
    try {
      const feed = await app.inject({ method: 'GET', url: '/feed/creations' });
      expect(feed.statusCode).toBe(200);
      const me = await app.inject({ method: 'GET', url: '/auth/me' });
      expect(me.statusCode).toBe(200);
      expect(me.json().accessGated).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('403s anonymous requests on non-exempt routes when gated', async () => {
    const app = await buildServer({
      gateway: null,
      auth: { provider: providerFor(null), accessAllowlist: ['alex'] },
    });
    try {
      const feed = await app.inject({ method: 'GET', url: '/feed/creations' });
      expect(feed.statusCode).toBe(403);
      expect(feed.json().error.code).toBe('access_gated');

      const privateVoice = await app.inject({
        method: 'GET',
        url: '/media/voice/00000000-0000-4000-8000-000000000001',
      });
      expect(privateVoice.statusCode).toBe(403);
      expect(privateVoice.json().error.code).toBe('access_gated');
    } finally {
      await app.close();
    }
  });

  it('keeps /health and /auth/me reachable for gated visitors', async () => {
    const app = await buildServer({
      gateway: null,
      auth: { provider: providerFor('stranger'), accessAllowlist: ['alex'] },
    });
    try {
      const health = await app.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(200);
      const me = await app.inject({ method: 'GET', url: '/auth/me' });
      expect(me.statusCode).toBe(200);
      expect(me.json().accessGated).toBe(true);
      expect(me.json().user?.username).toBe('stranger');
    } finally {
      await app.close();
    }
  });

  it('does not exempt paths that merely share a protected prefix', async () => {
    const app = await buildServer({
      gateway: null,
      auth: { provider: providerFor(null), accessAllowlist: ['alex'] },
    });
    try {
      const lookalike = await app.inject({ method: 'GET', url: '/health-check' });
      expect(lookalike.statusCode).toBe(403);
      expect(lookalike.json().error.code).toBe('access_gated');
    } finally {
      await app.close();
    }
  });

  it('403s signed-in accounts that are not on the list', async () => {
    const app = await buildServer({
      gateway: null,
      auth: { provider: providerFor('stranger'), accessAllowlist: ['alex', 'sam'] },
    });
    try {
      const feed = await app.inject({ method: 'GET', url: '/feed/creations' });
      expect(feed.statusCode).toBe(403);
      expect(feed.json().error.code).toBe('access_gated');
    } finally {
      await app.close();
    }
  });

  it('passes allowlisted accounts, case-insensitively', async () => {
    const app = await buildServer({
      gateway: null,
      auth: { provider: providerFor('Alex'), accessAllowlist: ['alex'] },
    });
    try {
      const feed = await app.inject({ method: 'GET', url: '/feed/creations' });
      expect(feed.statusCode).toBe(200);
      const me = await app.inject({ method: 'GET', url: '/auth/me' });
      expect(me.json().accessGated).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('never gates the Stripe webhook path (signature auth, not session auth)', async () => {
    const app = await buildServer({
      gateway: null,
      auth: { provider: providerFor(null), accessAllowlist: ['alex'] },
    });
    try {
      const hook = await app.inject({ method: 'POST', url: '/billing/webhook', payload: {} });
      // Rejected for a missing/invalid Stripe signature — but by the billing
      // route itself, never by the gate.
      expect(hook.statusCode).not.toBe(403);
      if (hook.statusCode >= 400) {
        expect(hook.json().error?.code ?? '').not.toBe('access_gated');
      }
    } finally {
      await app.close();
    }
  });
});
