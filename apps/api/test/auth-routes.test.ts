import { afterEach, describe, expect, it } from 'vitest';

import { credit, type AuthProvider } from '@eden3/core';
import { pg } from '@eden3/db';

import { ClerkAuthProvider } from '../src/clerk-auth-provider';
import { buildServer } from '../src/server';
import {
  addCollectionCreation,
  deleteFixturesByMarker,
  fakeHex24,
  insertAgentAccount,
  insertCollection,
  insertCreation,
  makeMarker,
} from './fixtures';

const marker = makeMarker('auth_routes');

describe('auth routes', () => {
  afterEach(async () => {
    await deleteFixturesByMarker(marker);
  });

  it('returns null for anonymous requests', async () => {
    const app = await buildServer({ gateway: null });
    try {
      const res = await app.inject({ method: 'GET', url: '/auth/me' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ user: null, manna: null, accessGated: false });
    } finally {
      await app.close();
    }
  });

  it('returns the authenticated account and manna balance', async () => {
    const username = `${marker}_gene`;
    const rows = await pg<{ id: string }[]>`
      insert into accounts (type, username)
      values ('user', ${username})
      returning id
    `;
    const accountId = rows[0]!.id;
    await credit({ accountId, amount: 123, type: 'credit:test' });

    const provider: AuthProvider = {
      async getSession() {
        return { accountId, username, isAdmin: true };
      },
    };
    const app = await buildServer({ gateway: null, auth: { provider } });
    try {
      const res = await app.inject({ method: 'GET', url: '/auth/me' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        user: {
          id: accountId,
          username,
          type: 'user',
          userImage: null,
          isAdmin: true,
        },
        manna: { balance: 123, subscriptionBalance: 0 },
        accessGated: false,
      });
    } finally {
      await app.close();
    }
  });

  it('uses a Clerk subject to land an existing migrated user on migrated data', async () => {
    const clerkUserId = `${marker}_clerk_subject`;
    const username = `${marker}_migrated`;
    const externalId = fakeHex24();
    const [user] = await pg<{ id: string }[]>`
      insert into accounts (type, username, external_id, clerk_user_id)
      values ('user', ${username}, ${externalId}, ${clerkUserId})
      returning id
    `;
    const accountId = user!.id;
    const agentId = await insertAgentAccount(`${marker}_agent`, {
      ownerId: accountId,
      public: true,
      persona: 'You remember migrated conversations.',
    });
    const creationId = await insertCreation({
      userId: accountId,
      agentId,
      externalId: fakeHex24(),
      url: 'https://media-one.example.invalid/auth-migrated.png',
    });
    const collectionId = await insertCollection({
      userId: accountId,
      name: `${marker} private migrated collection`,
      public: false,
      externalId: fakeHex24(),
    });
    await addCollectionCreation(collectionId, creationId, 1);
    const [session] = await pg<{ id: string; externalId: string }[]>`
      insert into sessions (external_id, owner_id, title, last_message_at, message_count)
      values (${fakeHex24()}, ${accountId}, ${`${marker} migrated session`}, now(), 2)
      returning id, external_id as "externalId"
    `;
    await pg`insert into session_users (session_id, user_account_id) values (${session!.id}, ${accountId})`;
    await pg`insert into session_agents (session_id, agent_account_id) values (${session!.id}, ${agentId})`;
    await pg`
      insert into messages (session_id, sender_id, role, content)
      values
        (${session!.id}, ${accountId}, 'user', 'This is migrated history.'),
        (${session!.id}, ${agentId}, 'assistant', 'I can see it.')
    `;
    await credit({ accountId, amount: 123, type: 'credit:test' });
    await credit({ accountId, amount: 45, type: 'credit:subscription_test', toSubscriptionBalance: true });

    const app = await buildServer({
      gateway: null,
      auth: {
        provider: new ClerkAuthProvider({
          seedManna: 999,
          verifyToken: async () => ({ sub: clerkUserId }),
        }),
      },
    });
    const headers = { authorization: 'Bearer valid-clerk-session' };
    try {
      const me = await app.inject({ method: 'GET', url: '/auth/me', headers });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({
        user: { id: accountId, username },
        manna: { balance: 123, subscriptionBalance: 45 },
      });

      const sessions = await app.inject({ method: 'GET', url: '/sessions', headers });
      expect(sessions.statusCode).toBe(200);
      expect(sessions.json().sessions.map((s: { id: string }) => s.id)).toContain(session!.id);

      const detail = await app.inject({
        method: 'GET',
        url: `/sessions/${session!.externalId}`,
        headers,
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().messages.map((m: { content: string | null }) => m.content)).toContain(
        'This is migrated history.',
      );

      const collection = await app.inject({
        method: 'GET',
        url: `/collections/${collectionId}`,
        headers,
      });
      expect(collection.statusCode).toBe(200);
      expect(collection.json().creations.map((c: { id: string }) => c.id)).toEqual([creationId]);

      const profile = await app.inject({
        method: 'GET',
        url: `/agents/${encodeURIComponent(`${marker}_agent`)}`,
        headers,
      });
      expect(profile.statusCode).toBe(200);
      expect(profile.json().agent).toMatchObject({
        id: agentId,
        persona: 'You remember migrated conversations.',
      });
      expect(profile.json().recentCreations.map((c: { id: string }) => c.id)).toContain(creationId);

      const accountCount = await pg<{ n: string }[]>`
        select count(*)::int8 as n from accounts where clerk_user_id = ${clerkUserId}
      `;
      expect(Number(accountCount[0]!.n)).toBe(1);
    } finally {
      await app.close();
    }
  });
});
