import { loadRootEnv, pg } from '@eden3/db';
import type { CreationDto } from '@eden3/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../src/server';
import {
  deleteFixturesByMarker,
  devCookie,
  fakeHex24,
  insertAgentAccount,
  insertCreation,
  insertUserAccount,
  makeMarker,
} from './fixtures';

loadRootEnv();

/**
 * Feed API against disposable Postgres. Deterministic assertions go through
 * fixture-backed agent/user filters; the global shape proof also relies only
 * on the three public fixture rows and never assumes a preloaded ETL corpus.
 */

const marker = makeMarker('feedapi');
const agentUsername = `${marker}_maker`;
const agentExternalId = fakeHex24();
let userId = '';
let agentId = '';
const creationIds: string[] = [];

let app: FastifyInstance;

interface FeedPage {
  items: CreationDto[];
  nextCursor: string | null;
}

beforeAll(async () => {
  userId = await insertUserAccount(`${marker}_user`);
  agentId = await insertAgentAccount(agentUsername, {
    ownerId: userId,
    name: 'Maker',
    public: true,
    externalId: agentExternalId,
  });
  // Old, stable timestamps: deterministic keyset order under the agent filter.
  for (const [index, iso] of [
    '2000-01-01T00:00:01Z',
    '2000-01-01T00:00:02Z',
    '2000-01-01T00:00:03Z',
  ].entries()) {
    creationIds.push(
      await insertCreation({
        userId,
        agentId,
        tool: index === 1 ? 'dream_search_target' : 'fixture_other',
        public: true,
        url: `https://media-one.example.invalid/fixture-${index}.png`,
        thumbnailUrl: `https://media-one.example.invalid/fixture-${index}_thumb.webp`,
        createdAt: new Date(iso),
      }),
    );
  }
  await insertCreation({ userId, agentId, public: false, createdAt: new Date('2000-01-01T00:00:04Z') });
  await insertCreation({
    userId,
    agentId,
    public: true,
    deleted: true,
    createdAt: new Date('2000-01-01T00:00:05Z'),
  });
  await insertCreation({
    userId,
    agentId,
    public: true,
    attributes: { nsfw_score: 0.99 },
    createdAt: new Date('2000-01-01T00:00:06Z'),
  });
  await pg`
    insert into creation_likes (user_id, creation_id)
    values (${userId}, ${creationIds[1]!})
  `;

  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await deleteFixturesByMarker(marker);
  await pg.end({ timeout: 5 });
});

describe('GET /feed/creations', () => {
  it('serves the global feed without relying on a preloaded database', async () => {
    const res = await app.inject({ method: 'GET', url: '/feed/creations?limit=2' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as FeedPage;
    expect(body.items).toHaveLength(2);
    expect(body.nextCursor).toBeTruthy();
    const first = body.items[0]!;
    expect(typeof first.id).toBe('string');
    expect(typeof first.createdAt).toBe('string');
  });

  it('filters by agent username, excludes private+deleted, serves URLs verbatim', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/feed/creations?agent=${agentUsername}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as FeedPage;
    expect(body.items).toHaveLength(3); // NOT private, deleted, or moderated ones
    expect(body.items.map((c) => c.id)).toEqual([...creationIds].reverse()); // newest first
    expect(body.items[0]!.url).toBe('https://media-one.example.invalid/fixture-2.png');
    expect(body.items[0]!.thumbnailUrl).toBe(
      'https://media-one.example.invalid/fixture-2_thumb.webp',
    );
    // Embedded summaries
    expect(body.items[0]!.agent?.username).toBe(agentUsername);
    expect(body.items[0]!.creator?.id).toBe(userId);
    expect(body.nextCursor).toBeNull();
  });

  it('paginates the filtered feed with a stable keyset cursor', async () => {
    const page1 = (
      await app.inject({ method: 'GET', url: `/feed/creations?agent=${agentUsername}&limit=2` })
    ).json() as FeedPage;
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = (
      await app.inject({
        method: 'GET',
        url: `/feed/creations?agent=${agentUsername}&limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`,
      })
    ).json() as FeedPage;
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    const ids = [...page1.items, ...page2.items].map((c) => c.id);
    expect(new Set(ids).size).toBe(3); // no dupes, no skips
  });

  it('accepts uuid and legacy 24-hex agent references', async () => {
    const byUuid = (
      await app.inject({ method: 'GET', url: `/feed/creations?agent=${agentId}` })
    ).json() as FeedPage;
    expect(byUuid.items).toHaveLength(3);
    const byHex = (
      await app.inject({ method: 'GET', url: `/feed/creations?agent=${agentExternalId}` })
    ).json() as FeedPage;
    expect(byHex.items).toHaveLength(3);
  });

  it('filters by user, and unknown filters return an empty page', async () => {
    const byUser = (
      await app.inject({ method: 'GET', url: `/feed/creations?user=${marker}_user` })
    ).json() as FeedPage;
    expect(byUser.items).toHaveLength(3);
    const unknown = (
      await app.inject({ method: 'GET', url: `/feed/creations?agent=${marker}_nobody` })
    ).json() as FeedPage;
    expect(unknown.items).toEqual([]);
    expect(unknown.nextCursor).toBeNull();
  });

  it('searches creations by tool name and embedded account username', async () => {
    const byTool = (
      await app.inject({
        method: 'GET',
        url: `/feed/creations?agent=${agentUsername}&q=dream_search_target`,
      })
    ).json() as FeedPage;
    expect(byTool.items).toHaveLength(1);
    expect(byTool.items[0]!.id).toBe(creationIds[1]);

    const byAgentUsername = (
      await app.inject({
        method: 'GET',
        url: `/feed/creations?agent=${agentUsername}&q=${agentUsername}`,
      })
    ).json() as FeedPage;
    expect(byAgentUsername.items).toHaveLength(3);

    const noMatch = (
      await app.inject({
        method: 'GET',
        url: `/feed/creations?agent=${agentUsername}&q=nope_${marker}`,
      })
    ).json() as FeedPage;
    expect(noMatch.items).toEqual([]);
    expect(noMatch.nextCursor).toBeNull();
  });

  it('provides an authenticated, browsable favorites list', async () => {
    const anonymous = await app.inject({
      method: 'GET',
      url: '/feed/creations?favorites=mine',
    });
    expect(anonymous.statusCode).toBe(401);

    const response = await app.inject({
      method: 'GET',
      url: '/feed/creations?favorites=mine',
      headers: { cookie: devCookie(userId) },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as FeedPage;
    expect(body.items.map((creation) => creation.id)).toEqual([creationIds[1]]);
    expect(body.items[0]!.viewerHasLiked).toBe(true);
    expect(body.nextCursor).toBeNull();
  });

  it('400s malformed cursors', async () => {
    const res = await app.inject({ method: 'GET', url: '/feed/creations?cursor=!!!' });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /feed/agents (recently active)', () => {
  it('surfaces an agent right after it creates something', async () => {
    // A just-now public creation puts the fixture agent into the newest slice.
    const recentId = await insertCreation({ userId, agentId, public: true });
    try {
      const res = await app.inject({ method: 'GET', url: '/feed/agents?limit=50' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        items: (CreationDto & { username: string; lastCreationAt: string })[];
      };
      expect(body.items.length).toBeGreaterThan(0);
      expect(body.items.length).toBeLessThanOrEqual(50);
      const mine = body.items.find((a) => a.username === agentUsername);
      expect(mine).toBeDefined();
      expect(typeof mine!.lastCreationAt).toBe('string');
    } finally {
      await pg`delete from creations where id = ${recentId}`;
    }
  });
});
