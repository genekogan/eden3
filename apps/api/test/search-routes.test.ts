import { loadRootEnv, pg } from '@eden3/db';
import type { OwnedSearchResponseDto } from '@eden3/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { escapeIlike } from '../src/routes/search';
import { buildServer } from '../src/server';
import {
  deleteFixturesByMarker,
  devCookie,
  insertAgentAccount,
  insertCollection,
  insertCreation,
  insertUserAccount,
  makeFakeCronSync,
  makeFakeProvisioner,
  makeMarker,
} from './fixtures';

loadRootEnv();

const marker = makeMarker('ownsearch');
const ownedAgentUsername = `${marker}_agent`;
let app: FastifyInstance;
let ownerId = '';
let otherId = '';
let ownedAgentId = '';
let otherAgentId = '';
let ownedCreationId = '';
let otherCreationId = '';
let ownedCollectionId = '';
let otherCollectionId = '';
let ownedSessionId = '';
let memberSessionId = '';
let otherSessionId = '';
let ownedTaskId = '';
let otherTaskId = '';

async function search(q: string, accountId = ownerId): Promise<OwnedSearchResponseDto> {
  const response = await app.inject({
    method: 'GET',
    url: `/search?q=${encodeURIComponent(q)}`,
    headers: { cookie: devCookie(accountId) },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as OwnedSearchResponseDto;
}

beforeAll(async () => {
  ownerId = await insertUserAccount(`${marker}_owner`);
  otherId = await insertUserAccount(`${marker}_other`);
  ownedAgentId = await insertAgentAccount(ownedAgentUsername, {
    ownerId,
    name: `${marker} Agent`,
    description: `${marker} private helper`,
    public: false,
  });
  otherAgentId = await insertAgentAccount(`${marker}_foreign_agent`, {
    ownerId: otherId,
    name: `${marker} Foreign Agent`,
    public: true,
  });

  ownedCreationId = await insertCreation({ userId: ownerId, agentId: ownedAgentId, public: false });
  otherCreationId = await insertCreation({ userId: otherId, agentId: otherAgentId, public: true });
  await pg`
    update creations set filename = ${`${marker} creation.png`},
      args = ${JSON.stringify({ prompt: `${marker} image prompt` })}::jsonb, updated_at = now()
    where id = ${ownedCreationId}
  `;
  await pg`
    update creations set filename = ${`${marker} foreign creation.png`}, updated_at = now()
    where id = ${otherCreationId}
  `;

  ownedCollectionId = await insertCollection({
    userId: ownerId,
    name: `${marker} Collection`,
    public: false,
  });
  otherCollectionId = await insertCollection({
    userId: otherId,
    name: `${marker} Foreign Collection`,
    public: true,
  });

  ownedSessionId = (
    await pg<{ id: string }[]>`
      insert into sessions (owner_id, title, visible, deleted)
      values (${ownerId}, ${`${marker} Owned Chat`}, true, false)
      returning id
    `
  )[0]!.id;
  memberSessionId = (
    await pg<{ id: string }[]>`
      insert into sessions (owner_id, title, visible, deleted)
      values (${otherId}, ${`${marker} Member Chat`}, true, false)
      returning id
    `
  )[0]!.id;
  otherSessionId = (
    await pg<{ id: string }[]>`
      insert into sessions (owner_id, title, visible, deleted)
      values (${otherId}, ${`${marker} Foreign Chat`}, true, false)
      returning id
    `
  )[0]!.id;
  await pg`
    insert into session_agents (session_id, agent_account_id) values
      (${ownedSessionId}, ${ownedAgentId}),
      (${memberSessionId}, ${ownedAgentId}),
      (${otherSessionId}, ${otherAgentId})
  `;
  await pg`
    insert into session_users (session_id, user_account_id)
    values (${memberSessionId}, ${ownerId})
  `;

  ownedTaskId = (
    await pg<{ id: string }[]>`
      insert into triggers (user_id, agent_id, name, prompt, schedule, status)
      values (${ownerId}, ${ownedAgentId}, ${`${marker} Task`}, ${`${marker} task prompt`},
              ${JSON.stringify({ at: '2099-01-01T00:00:00.000Z' })}::jsonb, 'active')
      returning id
    `
  )[0]!.id;
  otherTaskId = (
    await pg<{ id: string }[]>`
      insert into triggers (user_id, agent_id, name, prompt, schedule, status)
      values (${otherId}, ${otherAgentId}, ${`${marker} Foreign Task`}, ${`${marker} foreign prompt`},
              ${JSON.stringify({ at: '2099-01-01T00:00:00.000Z' })}::jsonb, 'active')
      returning id
    `
  )[0]!.id;

  app = await buildServer({
    provisioning: { provisioner: makeFakeProvisioner(), cronSync: makeFakeCronSync() },
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await deleteFixturesByMarker(marker);
  await pg.end({ timeout: 5 });
});

describe('GET /search', () => {
  it('requires authentication and escapes ILIKE metacharacters', async () => {
    expect((await app.inject({ method: 'GET', url: '/search?q=test' })).statusCode).toBe(401);
    expect(escapeIlike('50%_off!')).toBe('50!%!_off!!');
  });

  it('returns all high-value owned classes and member sessions without cross-user leakage', async () => {
    const body = await search(marker);
    const ids = new Set(body.items.map((item) => item.id));
    expect(ids).toEqual(
      new Set([
        ownedAgentId,
        ownedSessionId,
        memberSessionId,
        ownedCreationId,
        ownedCollectionId,
        ownedTaskId,
      ]),
    );
    expect(ids.has(otherAgentId)).toBe(false);
    expect(ids.has(otherSessionId)).toBe(false);
    expect(ids.has(otherCreationId)).toBe(false);
    expect(ids.has(otherCollectionId)).toBe(false);
    expect(ids.has(otherTaskId)).toBe(false);
    expect(new Set(body.items.map((item) => item.kind))).toEqual(
      new Set(['agent', 'session', 'creation', 'collection', 'task']),
    );
    expect(body.items.find((item) => item.id === ownedSessionId)?.target).toEqual({
      type: 'navigate',
      href: `/agents/${ownedAgentUsername}/chats/${ownedSessionId}`,
    });
  });

  it('reflects committed task create, edit, and delete immediately', async () => {
    const cookie = devCookie(ownerId);
    const createdResponse = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: { cookie },
      payload: {
        agentUsername: ownedAgentUsername,
        name: `${marker} Draft Dispatch`,
        prompt: 'Send the draft',
        schedule: { at: '2099-02-01T00:00:00.000Z' },
      },
    });
    expect(createdResponse.statusCode).toBe(201);
    const taskId = (createdResponse.json() as { task: { id: string } }).task.id;
    expect((await search('Draft Dispatch')).items.map((item) => item.id)).toContain(taskId);

    const editedResponse = await app.inject({
      method: 'PATCH',
      url: `/tasks/${taskId}`,
      headers: { cookie },
      payload: { name: `${marker} Final Dispatch` },
    });
    expect(editedResponse.statusCode).toBe(200);
    expect((await search('Draft Dispatch')).items.map((item) => item.id)).not.toContain(taskId);
    expect((await search('Final Dispatch')).items.map((item) => item.id)).toContain(taskId);

    const deletedResponse = await app.inject({
      method: 'PATCH',
      url: `/tasks/${taskId}`,
      headers: { cookie },
      payload: { deleted: true },
    });
    expect(deletedResponse.statusCode).toBe(200);
    expect((await search('Final Dispatch')).items.map((item) => item.id)).not.toContain(taskId);
  });
});
