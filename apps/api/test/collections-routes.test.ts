import { DevAuthProvider } from '@eden3/core';
import { loadRootEnv, pg } from '@eden3/db';
import type { CollectionDto, CreationDto } from '@eden3/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../src/server';
import {
  addCollectionCreation,
  deleteFixturesByMarker,
  devCookie,
  fakeHex24,
  insertAgentAccount,
  insertCollection,
  insertCreation,
  insertUserAccount,
  makeMarker,
} from './fixtures';

loadRootEnv();

/** Collections detail + per-user listing against live Postgres. */

const marker = makeMarker('colapi');
const externalId = fakeHex24();
let ownerId = '';
let strangerId = '';
let adminId = '';
let agentId = '';
let collectionId = '';
let privateCollectionId = '';
const memberIds: string[] = []; // position order 1..3
let boundarySafeMemberId = '';
let moderatedMemberId = '';
let boundaryModeratedMemberId = '';
let privateMemberId = '';

let app: FastifyInstance;

interface DetailBody {
  collection: CollectionDto;
  creations: CreationDto[];
  nextCursor: string | null;
}
interface ListBody {
  items: CollectionDto[];
  nextCursor: string | null;
}

beforeAll(async () => {
  ownerId = await insertUserAccount(`${marker}_owner`);
  strangerId = await insertUserAccount(`${marker}_str`);
  adminId = await insertUserAccount(`${marker}_admin`);
  agentId = await insertAgentAccount(`${marker}_agent`, { ownerId, public: true });

  collectionId = await insertCollection({
    userId: ownerId,
    name: 'Fixture Collection',
    public: true,
    externalId,
    createdAt: new Date('2020-01-02T00:00:00Z'),
  });
  privateCollectionId = await insertCollection({
    userId: ownerId,
    name: 'Secret Stash',
    public: false,
    createdAt: new Date('2020-01-01T00:00:00Z'),
  });

  // Three public members, inserted out of order; positions define the order.
  const urls = ['m1', 'm2', 'm3'];
  const ids = await Promise.all(
    urls.map((u) =>
      insertCreation({
        userId: ownerId,
        agentId,
        public: true,
        url: `https://media-one.example.invalid/${u}.png`,
      }),
    ),
  );
  memberIds.push(...ids);
  await addCollectionCreation(collectionId, ids[1]!, 2);
  await addCollectionCreation(collectionId, ids[0]!, 1);
  await addCollectionCreation(collectionId, ids[2]!, 3);
  moderatedMemberId = await insertCreation({
    userId: ownerId,
    agentId,
    public: true,
    url: `https://media-one.example.invalid/${marker}-moderated.png`,
    thumbnailUrl: `https://media-one.example.invalid/${marker}-moderated-thumb.png`,
    attributes: { nsfw_score: 0.99 },
    createdAt: new Date('2020-01-02T00:00:01Z'),
  });
  await addCollectionCreation(collectionId, moderatedMemberId, 0);
  boundaryModeratedMemberId = await insertCreation({
    userId: ownerId,
    agentId,
    public: true,
    attributes: { nsfw_score: 0.85 },
    createdAt: new Date('2020-01-02T00:00:02Z'),
  });
  await addCollectionCreation(collectionId, boundaryModeratedMemberId, 0);
  boundarySafeMemberId = await insertCreation({
    userId: ownerId,
    agentId,
    public: true,
    url: `https://media-one.example.invalid/${marker}-boundary-safe.png`,
    attributes: { nsfw_score: 0.849 },
  });
  await addCollectionCreation(collectionId, boundarySafeMemberId, 4);
  // A private member (hidden from non-owners) and a deleted one (hidden always).
  privateMemberId = await insertCreation({ userId: ownerId, agentId, public: false });
  await addCollectionCreation(collectionId, privateMemberId, 5);
  const deletedMember = await insertCreation({ userId: ownerId, agentId, public: true, deleted: true });
  await addCollectionCreation(collectionId, deletedMember, 6);

  await addCollectionCreation(privateCollectionId, ids[0]!, 1);

  app = await buildServer({
    auth: { provider: new DevAuthProvider({ adminUsernames: [`${marker}_admin`] }) },
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await deleteFixturesByMarker(marker);
  await pg.end({ timeout: 5 });
});

describe('GET /collections/:idOrExternal', () => {
  it('returns members in position order (public only for anonymous)', async () => {
    const res = await app.inject({ method: 'GET', url: `/collections/${collectionId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as DetailBody;
    expect(body.collection.name).toBe('Fixture Collection');
    expect(body.collection.creationCount).toBe(4);
    expect(body.creations.map((c) => c.id)).toEqual([...memberIds, boundarySafeMemberId]);
    expect(body.creations[0]!.url).toBe('https://media-one.example.invalid/m1.png');
    expect(body.nextCursor).toBeNull();
  });

  it('shows private members to the owner', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/collections/${collectionId}`,
      headers: { cookie: devCookie(ownerId) },
    });
    const body = res.json() as DetailBody;
    expect(body.collection.creationCount).toBe(7);
    expect(body.creations.map((c) => c.id)).toEqual([
      moderatedMemberId,
      boundaryModeratedMemberId,
      ...memberIds,
      boundarySafeMemberId,
      privateMemberId,
    ]);

    const admin = await app.inject({
      method: 'GET',
      url: `/collections/${collectionId}`,
      headers: { cookie: devCookie(adminId) },
    });
    const adminBody = admin.json() as DetailBody;
    expect(adminBody.collection.creationCount).toBe(7);
    expect(adminBody.creations.map((c) => c.id)).toEqual(body.creations.map((c) => c.id));
  });

  it('paginates members with the offset cursor', async () => {
    const page1 = (
      await app.inject({ method: 'GET', url: `/collections/${collectionId}?limit=2` })
    ).json() as DetailBody;
    expect(page1.creations.map((c) => c.id)).toEqual(memberIds.slice(0, 2));
    expect(page1.nextCursor).toBeTruthy();
    const page2 = (
      await app.inject({
        method: 'GET',
        url: `/collections/${collectionId}?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`,
      })
    ).json() as DetailBody;
    expect(page2.creations.map((c) => c.id)).toEqual([
      ...memberIds.slice(2),
      boundarySafeMemberId,
    ]);
    expect(page2.nextCursor).toBeNull();
  });

  it('resolves legacy 24-hex external ids', async () => {
    const res = await app.inject({ method: 'GET', url: `/collections/${externalId}` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as DetailBody).collection.id).toBe(collectionId);
  });

  it('404s private collections for non-owners, 200 for the owner', async () => {
    expect(
      (await app.inject({ method: 'GET', url: `/collections/${privateCollectionId}` })).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/collections/${privateCollectionId}`,
          headers: { cookie: devCookie(strangerId) },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/collections/${privateCollectionId}`,
          headers: { cookie: devCookie(ownerId) },
        })
      ).statusCode,
    ).toBe(200);
  });

  it('400s malformed cursors and 404s unknown refs', async () => {
    expect(
      (await app.inject({ method: 'GET', url: `/collections/${collectionId}?cursor=zzz` }))
        .statusCode,
    ).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/collections/${fakeHex24()}` })).statusCode).toBe(
      404,
    );
  });
});

describe('collection mutations', () => {
  it('creates a collection for the signed-in user', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/collections',
      headers: { cookie: devCookie(ownerId) },
      payload: { name: `${marker} Created`, description: 'created in test', public: false },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { collection: CollectionDto };
    expect(body.collection.userId).toBe(ownerId);
    expect(body.collection.name).toBe(`${marker} Created`);
    expect(body.collection.public).toBe(false);
  });

  it('adds, reorders, and removes creations in owner-controlled position order', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/collections',
      headers: { cookie: devCookie(ownerId) },
      payload: { name: `${marker} Mutable`, public: true },
    });
    const targetId = (created.json() as { collection: CollectionDto }).collection.id;

    const addA = await app.inject({
      method: 'POST',
      url: `/collections/${targetId}/creations`,
      headers: { cookie: devCookie(ownerId) },
      payload: { creationId: memberIds[2], position: 2 },
    });
    expect(addA.statusCode).toBe(201);
    const addB = await app.inject({
      method: 'POST',
      url: `/collections/${targetId}/creations`,
      headers: { cookie: devCookie(ownerId) },
      payload: { creationId: memberIds[0], position: 1 },
    });
    expect(addB.statusCode).toBe(201);

    const detail = (
      await app.inject({ method: 'GET', url: `/collections/${targetId}` })
    ).json() as DetailBody;
    expect(detail.creations.map((c) => c.id)).toEqual([memberIds[0], memberIds[2]]);

    const reorder = await app.inject({
      method: 'POST',
      url: `/collections/${targetId}/creations`,
      headers: { cookie: devCookie(ownerId) },
      payload: { creationId: memberIds[0], position: 3 },
    });
    expect(reorder.statusCode).toBe(201);
    const reordered = (
      await app.inject({ method: 'GET', url: `/collections/${targetId}` })
    ).json() as DetailBody;
    expect(reordered.creations.map((c) => c.id)).toEqual([memberIds[2], memberIds[0]]);

    const remove = await app.inject({
      method: 'DELETE',
      url: `/collections/${targetId}/creations/${memberIds[2]}`,
      headers: { cookie: devCookie(ownerId) },
    });
    expect(remove.statusCode).toBe(200);
    const afterRemove = (
      await app.inject({ method: 'GET', url: `/collections/${targetId}` })
    ).json() as DetailBody;
    expect(afterRemove.creations.map((c) => c.id)).toEqual([memberIds[0]]);
  });

  it('rejects collection mutation by non-owners', async () => {
    const add = await app.inject({
      method: 'POST',
      url: `/collections/${collectionId}/creations`,
      headers: { cookie: devCookie(strangerId) },
      payload: { creationId: memberIds[0] },
    });
    expect(add.statusCode).toBe(403);
    const remove = await app.inject({
      method: 'DELETE',
      url: `/collections/${collectionId}/creations/${memberIds[0]}`,
      headers: { cookie: devCookie(strangerId) },
    });
    expect(remove.statusCode).toBe(403);
  });
});

describe('GET /users/:username/collections', () => {
  it('lists public collections with counts + covers for anonymous viewers', async () => {
    const res = await app.inject({ method: 'GET', url: `/users/${marker}_owner/collections` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ListBody;
    expect(body.items.map((c) => c.id)).toContain(collectionId);
    expect(body.items.map((c) => c.id)).not.toContain(privateCollectionId);
    const item = body.items.find((c) => c.id === collectionId)!;
    expect(item.creationCount).toBe(4);
    expect(item.coverCreations?.map((c) => c.id)).toEqual([
      ...memberIds,
      boundarySafeMemberId,
    ]);
    expect(JSON.stringify(item)).not.toContain(`${marker}-moderated`);
  });

  it('retains moderated collection members for the owner and admin without exposing them to strangers', async () => {
    const stranger = await app.inject({
      method: 'GET',
      url: `/users/${marker}_owner/collections`,
      headers: { cookie: devCookie(strangerId) },
    });
    const strangerItem = (stranger.json() as ListBody).items.find((c) => c.id === collectionId)!;
    expect(strangerItem.creationCount).toBe(4);
    expect(strangerItem.coverCreations?.map((c) => c.id)).toEqual([
      ...memberIds,
      boundarySafeMemberId,
    ]);

    const owner = await app.inject({
      method: 'GET',
      url: `/users/${marker}_owner/collections`,
      headers: { cookie: devCookie(ownerId) },
    });
    const ownerItem = (owner.json() as ListBody).items.find((c) => c.id === collectionId)!;
    expect(ownerItem.creationCount).toBe(7);
    expect(ownerItem.coverCreations?.map((c) => c.id)).toEqual([
      moderatedMemberId,
      boundaryModeratedMemberId,
      memberIds[0],
      memberIds[1],
    ]);

    const admin = await app.inject({
      method: 'GET',
      url: `/users/${marker}_owner/collections`,
      headers: { cookie: devCookie(adminId) },
    });
    const adminItem = (admin.json() as ListBody).items.find((c) => c.id === collectionId)!;
    expect(adminItem.creationCount).toBe(7);
    expect(adminItem.coverCreations?.map((c) => c.id)).toEqual(
      ownerItem.coverCreations?.map((c) => c.id),
    );
  });

  it('includes private collections for the owner', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/users/${marker}_owner/collections`,
      headers: { cookie: devCookie(ownerId) },
    });
    const body = res.json() as ListBody;
    expect(body.items.map((c) => c.id)).toContain(collectionId);
    expect(body.items.map((c) => c.id)).toContain(privateCollectionId);
  });

  it('404s unknown users', async () => {
    const res = await app.inject({ method: 'GET', url: `/users/${marker}_missing/collections` });
    expect(res.statusCode).toBe(404);
  });
});
