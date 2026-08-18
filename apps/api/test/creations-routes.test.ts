import { randomUUID } from 'node:crypto';

import { DevAuthProvider } from '@eden3/core';
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

/** Creation permalink resolution (uuid + legacy hex) against live Postgres. */

const marker = makeMarker('crapi');
const externalId = fakeHex24();
let ownerId = '';
let strangerId = '';
let adminId = '';
let agentId = '';
let publicId = '';
let privateId = '';
let deletedId = '';
let moderatedId = '';
let concurrentReportCreationId = '';

let app: FastifyInstance;

beforeAll(async () => {
  ownerId = await insertUserAccount(`${marker}_owner`);
  strangerId = await insertUserAccount(`${marker}_str`);
  adminId = await insertUserAccount(`${marker}_admin`);
  agentId = await insertAgentAccount(`${marker}_agent`, { ownerId, public: true });
  publicId = await insertCreation({
    userId: ownerId,
    agentId,
    public: true,
    externalId,
    url: 'https://media-one.example.invalid/legacy.png',
  });
  privateId = await insertCreation({ userId: ownerId, agentId, public: false });
  deletedId = await insertCreation({ userId: ownerId, agentId, public: true, deleted: true });
  moderatedId = await insertCreation({
    userId: ownerId,
    agentId,
    public: true,
    attributes: { nsfw_score: 0.99 },
  });
  concurrentReportCreationId = await insertCreation({ userId: ownerId, agentId, public: true });

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

describe('GET /creations/:idOrExternal', () => {
  it('resolves by uuid with embedded creator/agent summaries', async () => {
    const res = await app.inject({ method: 'GET', url: `/creations/${publicId}` });
    expect(res.statusCode).toBe(200);
    const { creation } = res.json() as { creation: CreationDto };
    expect(creation.id).toBe(publicId);
    expect(creation.externalId).toBe(externalId);
    expect(creation.url).toBe('https://media-one.example.invalid/legacy.png'); // verbatim
    expect(creation.creator?.username).toBe(`${marker}_owner`);
    expect(creation.agent?.username).toBe(`${marker}_agent`);
    expect(creation.reportable).toBe(true);
  });

  it('resolves by legacy 24-hex external id (permalink)', async () => {
    const res = await app.inject({ method: 'GET', url: `/creations/${externalId}` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { creation: CreationDto }).creation.id).toBe(publicId);
  });

  it('hides private creations from anonymous + strangers, shows the creator', async () => {
    expect((await app.inject({ method: 'GET', url: `/creations/${privateId}` })).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/creations/${privateId}`,
          headers: { cookie: devCookie(strangerId) },
        })
      ).statusCode,
    ).toBe(404);
    const asOwner = await app.inject({
      method: 'GET',
      url: `/creations/${privateId}`,
      headers: { cookie: devCookie(ownerId) },
    });
    expect(asOwner.statusCode).toBe(200);
    expect((asOwner.json() as { creation: CreationDto }).creation.reportable).toBe(false);
  });

  it('keeps deleted creation details unreachable, including to their owner', async () => {
    for (const cookie of [undefined, devCookie(ownerId), devCookie(adminId)]) {
      const res = await app.inject({
        method: 'GET',
        url: `/creations/${deletedId}`,
        ...(cookie === undefined ? {} : { headers: { cookie } }),
      });
      expect(res.statusCode).toBe(404);
    }
  });

  it('404s unknown ids and garbage refs', async () => {
    for (const ref of [randomUUID(), fakeHex24(), 'not-a-ref']) {
      const res = await app.inject({ method: 'GET', url: `/creations/${ref}` });
      expect(res.statusCode, ref).toBe(404);
    }
  });

  it('hides high-NSFW public creations from public viewers but not owners/admins', async () => {
    expect((await app.inject({ method: 'GET', url: `/creations/${moderatedId}` })).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/creations/${moderatedId}`,
          headers: { cookie: devCookie(strangerId) },
        })
      ).statusCode,
    ).toBe(404);
    for (const cookie of [devCookie(ownerId), devCookie(adminId)]) {
      const visible = await app.inject({
        method: 'GET',
        url: `/creations/${moderatedId}`,
        headers: { cookie },
      });
      expect(visible.statusCode).toBe(200);
      expect((visible.json() as { creation: CreationDto }).creation.reportable).toBe(false);
    }
  });
});

describe('creation reports and takedowns', () => {
  it('lets signed-in users report visible public creations', async () => {
    expect(
      (await app.inject({ method: 'POST', url: `/creations/${publicId}/report` })).statusCode,
    ).toBe(401);

    const res = await app.inject({
      method: 'POST',
      url: `/creations/${publicId}/report`,
      headers: { cookie: devCookie(strangerId) },
      payload: { reason: 'looks unsafe for the public feed' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { report: { id: string; targetId: string; status: string } };
    expect(body.report).toMatchObject({ targetId: publicId, status: 'open' });

    const [row] = await pg<{ count: string }[]>`
      select count(*) from content_reports
      where reporter_id = ${strangerId}
        and target_type = 'creation'
        and target_id = ${publicId}
        and reason = 'looks unsafe for the public feed'
        and status = 'open'
    `;
    expect(Number(row!.count)).toBe(1);

    const duplicate = await app.inject({
      method: 'POST',
      url: `/creations/${publicId}/report`,
      headers: { cookie: devCookie(strangerId) },
      payload: { reason: 'a second click must not create another open report' },
    });
    expect(duplicate.statusCode).toBe(200);
    expect((duplicate.json() as { report: { id: string } }).report.id).toBe(body.report.id);

    const [afterDuplicate] = await pg<{ count: string }[]>`
      select count(*) from content_reports
      where reporter_id = ${strangerId}
        and target_type = 'creation'
        and target_id = ${publicId}
        and status = 'open'
    `;
    expect(Number(afterDuplicate!.count)).toBe(1);
  });

  it('generically rejects reports for content that is not publicly reachable', async () => {
    for (const targetId of [privateId, deletedId, moderatedId, randomUUID()]) {
      const res = await app.inject({
        method: 'POST',
        url: `/creations/${targetId}/report`,
        headers: { cookie: devCookie(ownerId) },
        payload: { reason: 'should not disclose the target state' },
      });
      expect(res.statusCode, targetId).toBe(404);
      expect(res.json()).toMatchObject({ error: { code: 'creation_not_found' } });
    }
  });

  it('creates exactly one open report under concurrent duplicate submissions', async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        app.inject({
          method: 'POST',
          url: `/creations/${concurrentReportCreationId}/report`,
          headers: { cookie: devCookie(strangerId) },
          payload: { reason: 'same report submitted concurrently' },
        }),
      ),
    );
    expect(responses.filter((response) => response.statusCode === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(7);
    expect(
      new Set(
        responses.map(
          (response) => (response.json() as { report: { id: string } }).report.id,
        ),
      ).size,
    ).toBe(1);

    const [row] = await pg<{ count: string }[]>`
      select count(*) from content_reports
      where reporter_id = ${strangerId}
        and target_type = 'creation'
        and target_id = ${concurrentReportCreationId}
        and status = 'open'
    `;
    expect(Number(row!.count)).toBe(1);
  });

  it('allows creator/admin takedown and blocks strangers', async () => {
    const stranger = await app.inject({
      method: 'DELETE',
      url: `/creations/${publicId}`,
      headers: { cookie: devCookie(strangerId) },
    });
    expect(stranger.statusCode).toBe(403);

    const admin = await app.inject({
      method: 'DELETE',
      url: `/creations/${publicId}`,
      headers: { cookie: devCookie(adminId) },
    });
    expect(admin.statusCode).toBe(200);
    expect(admin.json()).toMatchObject({ ok: true, creationId: publicId, deleted: true });
    expect((await app.inject({ method: 'GET', url: `/creations/${publicId}` })).statusCode).toBe(404);
  });
});
