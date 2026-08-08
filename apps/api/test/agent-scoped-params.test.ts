import { loadRootEnv, pg } from '@eden3/db';
import type { CreationDto, SessionDto } from '@eden3/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../src/server';
import {
  deleteFixturesByMarker,
  devCookie,
  insertAgentAccount,
  insertCreation,
  insertUserAccount,
  makeMarker,
} from './fixtures';

loadRootEnv();

/**
 * The `?agent=` filter params added for the agent-scoped cockpit UI
 * (GET /sessions, GET /tasks, GET /usage/summary) plus `user=me` own-content
 * visibility on GET /feed/creations. Live-Postgres tests, fixture-marker
 * cleanup like every other route suite.
 */

const marker = makeMarker('agscope');
const agentAUsername = `${marker}_agent_a`;
const agentBUsername = `${marker}_agent_b`;
let userId = '';
let agentAId = '';
let agentBId = '';
let sessionAId = '';
let sessionBId = '';
let publicCreationId = '';
let privateCreationId = '';
let nsfwCreationId = '';

let app: FastifyInstance;

async function insertSessionWithAgent(title: string, agentId: string): Promise<string> {
  const [row] = await pg<{ id: string }[]>`
    insert into sessions (owner_id, title, last_message_at, message_count)
    values (${userId}, ${title}, now(), 1)
    returning id
  `;
  await pg`
    insert into session_agents (session_id, agent_account_id)
    values (${row!.id}, ${agentId})
  `;
  return row!.id;
}

async function insertTrigger(agentId: string, name: string): Promise<string> {
  const [row] = await pg<{ id: string }[]>`
    insert into triggers (user_id, agent_id, name, prompt, schedule, status,
                          session_target, next_scheduled_run, deleted, error_count)
    values (${userId}, ${agentId}, ${name}, 'scheduled prompt',
            ${JSON.stringify({ hour: 9, minute: 0 })}::jsonb, 'active',
            'new', null, false, 0)
    returning id
  `;
  return row!.id;
}

beforeAll(async () => {
  userId = await insertUserAccount(`${marker}_user`);
  agentAId = await insertAgentAccount(agentAUsername, { ownerId: userId, name: 'Agent A' });
  agentBId = await insertAgentAccount(agentBUsername, { ownerId: userId, name: 'Agent B' });

  sessionAId = await insertSessionWithAgent(`${marker} session A`, agentAId);
  sessionBId = await insertSessionWithAgent(`${marker} session B`, agentBId);

  await insertTrigger(agentAId, `${marker} task A`);
  await insertTrigger(agentBId, `${marker} task B`);

  await pg`
    insert into usage_events (event_type, status, user_id, agent_id, provider, model, manna, created_at)
    values
      ('chat_turn', 'completed', ${userId}, ${agentAId}, 'anthropic', 'claude-haiku-4-5', 10, now() - interval '3 minutes'),
      ('chat_turn', 'completed', ${userId}, ${agentAId}, 'anthropic', 'claude-haiku-4-5', 5, now() - interval '2 minutes'),
      ('chat_turn', 'completed', ${userId}, ${agentBId}, 'anthropic', 'claude-haiku-4-5', 7, now() - interval '1 minute')
  `;

  publicCreationId = await insertCreation({ userId, agentId: agentAId, public: true });
  privateCreationId = await insertCreation({ userId, agentId: agentAId, public: false });
  nsfwCreationId = await insertCreation({
    userId,
    agentId: agentAId,
    public: true,
    attributes: { nsfw_score: 0.99 },
  });
  await insertCreation({ userId, agentId: agentAId, public: true, deleted: true });

  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await deleteFixturesByMarker(marker);
  await pg.end({ timeout: 5 });
});

describe('GET /sessions?agent=', () => {
  it('filters to sessions the agent participates in', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sessions?agent=${agentAUsername}`,
      headers: { cookie: devCookie(userId) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { sessions: SessionDto[]; nextCursor: string | null };
    expect(body.sessions.map((s) => s.id)).toEqual([sessionAId]);
  });

  it('returns everything without the filter', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/sessions',
      headers: { cookie: devCookie(userId) },
    });
    const ids = (res.json() as { sessions: SessionDto[] }).sessions.map((s) => s.id);
    expect(ids).toContain(sessionAId);
    expect(ids).toContain(sessionBId);
  });

  it('returns an empty page for an unknown agent ref', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sessions?agent=${marker}_nobody`,
      headers: { cookie: devCookie(userId) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessions: [], nextCursor: null });
  });

  it('accepts a uuid agent ref', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/sessions?agent=${agentBId}`,
      headers: { cookie: devCookie(userId) },
    });
    const body = res.json() as { sessions: SessionDto[] };
    expect(body.sessions.map((s) => s.id)).toEqual([sessionBId]);
  });
});

describe('GET /tasks?agent=', () => {
  it('filters to one agent, and unknown agents yield an empty page', async () => {
    const filtered = await app.inject({
      method: 'GET',
      url: `/tasks?agent=${agentAUsername}`,
      headers: { cookie: devCookie(userId) },
    });
    expect(filtered.statusCode).toBe(200);
    const body = filtered.json() as { items: Array<{ name: string }> };
    expect(body.items.map((t) => t.name)).toEqual([`${marker} task A`]);

    const unknown = await app.inject({
      method: 'GET',
      url: `/tasks?agent=${marker}_nobody`,
      headers: { cookie: devCookie(userId) },
    });
    expect(unknown.json()).toEqual({ items: [], nextCursor: null });
  });

  it('still returns all agents without the filter', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/tasks',
      headers: { cookie: devCookie(userId) },
    });
    const names = (res.json() as { items: Array<{ name: string }> }).items.map((t) => t.name);
    expect(names).toContain(`${marker} task A`);
    expect(names).toContain(`${marker} task B`);
  });
});

describe('GET /usage/summary?agent=', () => {
  interface Summary {
    balance: { total: number };
    spend: { week: { manna: number; events: number }; month: { manna: number; events: number } };
    recent: Array<{ agentUsername: string | null; manna: number | null }>;
  }

  it('scopes spend windows and recent events to the agent; balance stays global', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/usage/summary?agent=${agentAUsername}`,
      headers: { cookie: devCookie(userId) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Summary;
    expect(body.spend.week).toEqual({ manna: 15, events: 2 });
    expect(body.spend.month).toEqual({ manna: 15, events: 2 });
    expect(body.recent).toHaveLength(2);
    expect(body.recent.every((row) => row.agentUsername === agentAUsername)).toBe(true);
    expect(body.balance).toBeDefined(); // account-level, not agent-scoped
  });

  it('covers all agents without the filter', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/usage/summary',
      headers: { cookie: devCookie(userId) },
    });
    const body = res.json() as Summary;
    expect(body.spend.month.manna).toBe(22);
    expect(body.spend.month.events).toBe(3);
  });

  it('yields zero spend and no events for an unknown agent ref', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/usage/summary?agent=${marker}_nobody`,
      headers: { cookie: devCookie(userId) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Summary;
    expect(body.spend.week).toEqual({ manna: 0, events: 0 });
    expect(body.spend.month).toEqual({ manna: 0, events: 0 });
    expect(body.recent).toEqual([]);
    expect(body.balance).toBeDefined();
  });
});

describe('GET /feed/creations?user=me (own-content visibility)', () => {
  it('401s anonymous callers', async () => {
    const res = await app.inject({ method: 'GET', url: '/feed/creations?user=me' });
    expect(res.statusCode).toBe(401);
  });

  it('returns the viewer\'s own creations including non-public and nsfw-flagged rows', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/feed/creations?user=me',
      headers: { cookie: devCookie(userId) },
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { items: CreationDto[] }).items.map((c) => c.id);
    expect(new Set(ids)).toEqual(new Set([publicCreationId, privateCreationId, nsfwCreationId]));
  });

  it('keeps the public+nsfw gates for other viewers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/feed/creations?user=${marker}_user`,
    });
    const ids = (res.json() as { items: CreationDto[] }).items.map((c) => c.id);
    expect(ids).toEqual([publicCreationId]);
  });
});
