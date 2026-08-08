import Fastify, { type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { requireAuth } from '../src/auth-plugin';
import { EventsBus } from '../src/events-bus';
import { notificationsRoutes } from '../src/routes/notifications';
import type { AppNotificationStore } from '../src/services/app-notifications';

const OWNER = '11111111-1111-4111-8111-111111111111';
const STRANGER = '22222222-2222-4222-8222-222222222222';
const NOTICE = '33333333-3333-4333-8333-333333333333';
const AGENT = '44444444-4444-4444-8444-444444444444';

class FakeStore implements AppNotificationStore {
  readonly calls: Array<{ op: string; accountId: string; id?: string }> = [];

  async list(accountId: string) {
    this.calls.push({ op: 'list', accountId });
    return {
      items:
        accountId === OWNER
          ? [
              {
                id: NOTICE,
                kind: 'agent_build_ready' as const,
                sourceAgent: {
                  id: AGENT,
                  type: 'agent' as const,
                  username: 'ready-agent',
                  userImage: null,
                },
                targetPath: '/agents/ready-agent',
                readAt: null,
                createdAt: '2026-08-08T12:00:00.000Z',
              },
            ]
          : [],
      unreadCount: accountId === OWNER ? 1 : 0,
    };
  }

  async markRead(accountId: string, id: string) {
    this.calls.push({ op: 'read', accountId, id });
    return accountId === OWNER && id === NOTICE;
  }

  async markAllRead(accountId: string) {
    this.calls.push({ op: 'read-all', accountId });
    return accountId === OWNER ? 1 : 0;
  }

  async dismiss(accountId: string, id: string) {
    this.calls.push({ op: 'dismiss', accountId, id });
    return accountId === OWNER && id === NOTICE;
  }
}

describe('notifications routes', () => {
  let app: ReturnType<typeof Fastify>;
  let store: FakeStore;

  beforeEach(async () => {
    app = Fastify();
    store = new FakeStore();
    app.decorateRequest('account', null);
    app.decorate('requireAuth', requireAuth);
    app.decorate('eventsBus', new EventsBus());
    app.addHook('onRequest', async (request: FastifyRequest) => {
      const accountId = request.headers['x-test-account'];
      request.account =
        typeof accountId === 'string'
          ? {
              accountId,
              username: accountId === OWNER ? 'owner' : 'stranger',
              isAdmin: false,
            }
          : null;
    });
    await app.register(notificationsRoutes, { prefix: '/notifications', store });
    await app.ready();
  });

  afterEach(async () => app.close());

  it('requires authentication and lists only the authenticated tenant', async () => {
    expect((await app.inject({ method: 'GET', url: '/notifications' })).statusCode).toBe(401);
    const owner = await app.inject({
      method: 'GET',
      url: '/notifications',
      headers: { 'x-test-account': OWNER },
    });
    expect(owner.statusCode).toBe(200);
    expect(owner.json()).toMatchObject({ unreadCount: 1, items: [{ id: NOTICE }] });
    expect(store.calls.at(-1)).toEqual({ op: 'list', accountId: OWNER });

    const stranger = await app.inject({
      method: 'GET',
      url: '/notifications',
      headers: { 'x-test-account': STRANGER },
    });
    expect(stranger.json()).toEqual({ unreadCount: 0, items: [] });
  });

  it('returns an indistinguishable 404 for another tenant notification', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/notifications/${NOTICE}/read`,
      headers: { 'x-test-account': STRANGER },
    });
    expect(response.statusCode).toBe(404);
    expect(store.calls.at(-1)).toEqual({ op: 'read', accountId: STRANGER, id: NOTICE });
  });

  it('marks all read and dismisses through tenant-scoped mutations', async () => {
    const ownerFrames: string[] = [];
    const strangerFrames: string[] = [];
    app.eventsBus.subscribe(`account:${OWNER}`, {
      write: (frame: string) => ownerFrames.push(frame),
    });
    app.eventsBus.subscribe(`account:${STRANGER}`, {
      write: (frame: string) => strangerFrames.push(frame),
    });
    const all = await app.inject({
      method: 'POST',
      url: '/notifications/read-all',
      headers: { 'x-test-account': OWNER },
    });
    expect(all.json()).toEqual({ ok: true, updated: 1 });

    const dismiss = await app.inject({
      method: 'DELETE',
      url: `/notifications/${NOTICE}`,
      headers: { 'x-test-account': OWNER },
    });
    expect(dismiss.statusCode).toBe(204);
    expect(store.calls.slice(-2)).toEqual([
      { op: 'read-all', accountId: OWNER },
      { op: 'dismiss', accountId: OWNER, id: NOTICE },
    ]);
    expect(ownerFrames).toHaveLength(2);
    expect(ownerFrames.every((frame) => frame.includes('notification.changed'))).toBe(true);
    expect(strangerFrames).toEqual([]);
  });
});
