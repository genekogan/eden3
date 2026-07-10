import { loadRootEnv, pg } from '@eden3/db';
import type { AgentDto, CreationDto } from '@eden3/shared';
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

const marker = makeMarker('likes');
let ownerId = '';
let likerId = '';
let strangerId = '';
let agentId = '';
let privateAgentUsername = '';
let publicCreationId = '';
let privateCreationId = '';
let app: FastifyInstance;

interface CreationEnvelope {
  creation: CreationDto;
}

interface AgentEnvelope {
  agent: AgentDto;
}

interface AgentProfileEnvelope extends AgentEnvelope {
  recentCreations: CreationDto[];
}

interface AgentListEnvelope {
  items: (AgentDto & { creationCount?: number; sessionCount?: number })[];
  nextCursor: string | null;
}

beforeAll(async () => {
  ownerId = await insertUserAccount(`${marker}_owner`);
  likerId = await insertUserAccount(`${marker}_liker`);
  strangerId = await insertUserAccount(`${marker}_stranger`);
  agentId = await insertAgentAccount(`${marker}_agent`, {
    ownerId,
    name: 'Likeable Agent',
    public: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  });
  privateAgentUsername = `${marker}_private_agent`;
  await insertAgentAccount(privateAgentUsername, {
    ownerId,
    name: 'Private Agent',
    public: false,
  });
  publicCreationId = await insertCreation({
    userId: ownerId,
    agentId,
    public: true,
    url: `https://cdn.example.com/${marker}.png`,
  });
  privateCreationId = await insertCreation({ userId: ownerId, agentId, public: false });

  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await deleteFixturesByMarker(marker);
  await pg.end({ timeout: 5 });
});

describe('creation likes', () => {
  it('likes and unlikes idempotently while exposing viewer state', async () => {
    const like = await app.inject({
      method: 'POST',
      url: `/creations/${publicCreationId}/like`,
      headers: { cookie: devCookie(likerId) },
    });
    expect(like.statusCode).toBe(200);
    expect((like.json() as CreationEnvelope).creation).toMatchObject({
      id: publicCreationId,
      likeCount: 1,
      viewerHasLiked: true,
    });

    const duplicate = await app.inject({
      method: 'POST',
      url: `/creations/${publicCreationId}/like`,
      headers: { cookie: devCookie(likerId) },
    });
    expect((duplicate.json() as CreationEnvelope).creation.likeCount).toBe(1);

    const detailForViewer = await app.inject({
      method: 'GET',
      url: `/creations/${publicCreationId}`,
      headers: { cookie: devCookie(likerId) },
    });
    expect((detailForViewer.json() as CreationEnvelope).creation.viewerHasLiked).toBe(true);

    const detailAnonymous = await app.inject({
      method: 'GET',
      url: `/creations/${publicCreationId}`,
    });
    expect((detailAnonymous.json() as CreationEnvelope).creation).toMatchObject({
      likeCount: 1,
      viewerHasLiked: false,
    });

    const unlike = await app.inject({
      method: 'DELETE',
      url: `/creations/${publicCreationId}/like`,
      headers: { cookie: devCookie(likerId) },
    });
    expect((unlike.json() as CreationEnvelope).creation).toMatchObject({
      likeCount: 0,
      viewerHasLiked: false,
    });

    const duplicateUnlike = await app.inject({
      method: 'DELETE',
      url: `/creations/${publicCreationId}/like`,
      headers: { cookie: devCookie(likerId) },
    });
    expect((duplicateUnlike.json() as CreationEnvelope).creation.likeCount).toBe(0);
  });

  it('hides private creations from non-owners but allows owner likes', async () => {
    const strangerLike = await app.inject({
      method: 'POST',
      url: `/creations/${privateCreationId}/like`,
      headers: { cookie: devCookie(strangerId) },
    });
    expect(strangerLike.statusCode).toBe(404);

    const ownerLike = await app.inject({
      method: 'POST',
      url: `/creations/${privateCreationId}/like`,
      headers: { cookie: devCookie(ownerId) },
    });
    expect(ownerLike.statusCode).toBe(200);
    expect((ownerLike.json() as CreationEnvelope).creation.viewerHasLiked).toBe(true);
  });
});

describe('agent likes', () => {
  it('likes and unlikes agents idempotently and surfaces counts in profile/list views', async () => {
    const like = await app.inject({
      method: 'POST',
      url: `/agents/${marker}_agent/like`,
      headers: { cookie: devCookie(likerId) },
    });
    expect(like.statusCode).toBe(200);
    expect((like.json() as AgentEnvelope).agent).toMatchObject({
      username: `${marker}_agent`,
      likeCount: 1,
      viewerHasLiked: true,
    });

    const duplicate = await app.inject({
      method: 'POST',
      url: `/agents/${marker}_agent/like`,
      headers: { cookie: devCookie(likerId) },
    });
    expect((duplicate.json() as AgentEnvelope).agent.likeCount).toBe(1);

    const profile = await app.inject({
      method: 'GET',
      url: `/agents/${marker}_agent`,
      headers: { cookie: devCookie(likerId) },
    });
    expect((profile.json() as AgentProfileEnvelope).agent).toMatchObject({
      likeCount: 1,
      viewerHasLiked: true,
    });

    const list = await app.inject({
      method: 'GET',
      url: `/agents?q=${encodeURIComponent(`${marker}_agent`)}`,
      headers: { cookie: devCookie(likerId) },
    });
    const listed = (list.json() as AgentListEnvelope).items.find(
      (agent) => agent.username === `${marker}_agent`,
    );
    expect(listed).toMatchObject({ likeCount: 1, viewerHasLiked: true });

    const unlike = await app.inject({
      method: 'DELETE',
      url: `/agents/${marker}_agent/like`,
      headers: { cookie: devCookie(likerId) },
    });
    expect((unlike.json() as AgentEnvelope).agent).toMatchObject({
      likeCount: 0,
      viewerHasLiked: false,
    });
  });

  it('hides private agents from non-owners but allows owner likes', async () => {
    const strangerLike = await app.inject({
      method: 'POST',
      url: `/agents/${privateAgentUsername}/like`,
      headers: { cookie: devCookie(strangerId) },
    });
    expect(strangerLike.statusCode).toBe(404);

    const ownerLike = await app.inject({
      method: 'POST',
      url: `/agents/${privateAgentUsername}/like`,
      headers: { cookie: devCookie(ownerId) },
    });
    expect(ownerLike.statusCode).toBe(200);
    expect((ownerLike.json() as AgentEnvelope).agent).toMatchObject({
      username: privateAgentUsername,
      likeCount: 1,
      viewerHasLiked: true,
    });
  });
});
