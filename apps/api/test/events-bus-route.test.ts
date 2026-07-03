import { randomUUID } from 'node:crypto';

import { DEV_USER_COOKIE, DevAuthProvider } from '@eden3/core';
import { loadRootEnv, pg } from '@eden3/db';
import { encodeSseEvent, type SessionEvent } from '@eden3/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { registerAuth } from '../src/auth-plugin';
import { EventsBus, sessionEventsRoutes } from '../src/events-bus';

loadRootEnv();

/**
 * GET /sessions/:id/events authorization (the SSE IDOR regression, W2 finding
 * #1). Real Postgres so resolveSession + canAccessSession run for real; a real
 * HTTP listener so reply.hijack() and the raw SSE socket are exercised end to
 * end. Fixtures: an owner, an unrelated user, and one session owned by owner.
 */

const marker = `evbustest_${randomUUID().slice(0, 8)}`;

let app: FastifyInstance;
let baseUrl = '';
let ownerId = '';
let strangerId = '';
let sessionId = '';

function cookieFor(accountId: string): string {
  return `${DEV_USER_COOKIE}=${accountId}`;
}

/** Open the SSE stream and resolve once the first data frame or `ms` arrives. */
async function collectFirstEvent(
  path: string,
  accountId: string | null,
  publishAfterOpen?: () => void,
): Promise<{ status: number; contentType: string | null; event: SessionEvent | null }> {
  const controller = new AbortController();
  const headers: Record<string, string> = { accept: 'text/event-stream' };
  if (accountId) headers.cookie = cookieFor(accountId);
  const res = await fetch(`${baseUrl}${path}`, { headers, signal: controller.signal });

  if (res.status !== 200 || !res.body) {
    controller.abort();
    return { status: res.status, contentType: res.headers.get('content-type'), event: null };
  }

  // Subscription is live the moment headers flush; publish now so the frame lands.
  publishAfterOpen?.();

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event: SessionEvent | null = null;
  const deadline = Date.now() + 5000;
  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
        if (dataLine) {
          event = JSON.parse(dataLine.slice('data: '.length)) as SessionEvent;
          break;
        }
      }
      if (event) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    controller.abort();
  }
  return { status: res.status, contentType: res.headers.get('content-type'), event };
}

beforeAll(async () => {
  const accounts = await pg<{ id: string }[]>`
    insert into accounts (type, username) values
      ('user', ${`${marker}_owner`}),
      ('user', ${`${marker}_stranger`})
    returning id
  `;
  ownerId = accounts[0]!.id;
  strangerId = accounts[1]!.id;

  const [session] = await pg<{ id: string }[]>`
    insert into sessions (owner_id, title) values (${ownerId}, ${`${marker} session`})
    returning id
  `;
  sessionId = session!.id;
  await pg`insert into session_users (session_id, user_account_id) values (${sessionId}, ${ownerId})`;

  app = Fastify({ logger: false, forceCloseConnections: true });
  // The route sends 401/403/404 via sendError (return, not throw), so no
  // custom error handler is needed — Fastify's default suffices here.
  registerAuth(app, {
    provider: new DevAuthProvider({
      lookupAccount: async (ref) => {
        const [row] = await pg<{ id: string; username: string; deleted: boolean }[]>`
          select id, username, deleted from accounts where id = ${ref}`;
        return row ?? null;
      },
    }),
  });
  app.decorate('eventsBus', new EventsBus());
  await app.register(sessionEventsRoutes);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no listen address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await app?.close();
  await pg`delete from session_users where session_id = ${sessionId}`;
  await pg`delete from sessions where id = ${sessionId}`;
  await pg`delete from accounts where username like ${`${marker}%`}`;
  await pg.end({ timeout: 5 });
});

describe('GET /sessions/:id/events — authorization (SSE IDOR guard)', () => {
  it('rejects an anonymous caller with 401 (no stream)', async () => {
    const res = await collectFirstEvent(`/sessions/${sessionId}/events`, null);
    expect(res.status).toBe(401);
    expect(res.contentType).not.toContain('text/event-stream');
  });

  it('rejects a non-member (wrong user) with 403 (no stream)', async () => {
    const res = await collectFirstEvent(`/sessions/${sessionId}/events`, strangerId);
    expect(res.status).toBe(403);
    expect(res.contentType).not.toContain('text/event-stream');
  });

  it('returns 404 for an unknown session id', async () => {
    const res = await collectFirstEvent(`/sessions/${randomUUID()}/events`, ownerId);
    expect(res.status).toBe(404);
  });

  it('streams to the owner and delivers a published event', async () => {
    const event: SessionEvent = { type: 'turn.started', sessionId, turnId: randomUUID() };
    const res = await collectFirstEvent(`/sessions/${sessionId}/events`, ownerId, () => {
      // Give the subscribe() a beat, then publish on the canonical channel.
      setTimeout(() => app.eventsBus.publish(sessionId, event), 100);
    });
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('text/event-stream');
    expect(res.event).toEqual(event);
    expect(encodeSseEvent(event)).toBe(`data: ${JSON.stringify(event)}\n\n`);
  });
});
