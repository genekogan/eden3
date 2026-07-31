import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { nextOccurrence as apiNextOccurrence } from '../../../apps/api/src/services/task-schedule.ts';
import {
  BridgeError,
  MAX_ENABLED_TASKS_PER_AGENT,
  MAX_RETAINED_SELF_CRON_TASKS_PER_AGENT,
  createBridgeServer,
  handleBridgeRequest,
  sessionIdFromContext,
} from '../../../infra/agent-cron-bridge/server.mjs';
import { nextOccurrence as bridgeNextOccurrence } from '../../../infra/agent-cron-bridge/schedule.mjs';
import { requestAgentCron } from '../../../infra/openclaw/plugins/eden3-cron/bridge-client.js';

const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';
const TASK_ID = '123e4567-e89b-42d3-a456-426614174001';
const identity = { ownerId: 'owner-id', agentAccountId: 'agent-account-id' };
const sockets = [];

afterEach(async () => {
  await Promise.all(
    sockets.splice(0).map(async ({ server, dir }) => {
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(dir, { recursive: true, force: true });
    }),
  );
});

function request(action, args = {}, overrides = {}) {
  return {
    protocolVersion: 1,
    agentId: 'film-bot',
    sessionKey: `agent:film-bot:eden3:s:${SESSION_ID}`,
    action,
    args,
    ...overrides,
  };
}

describe('agent cron bridge identity and protocol', () => {
  it('accepts only the matching scoped Eden session context', () => {
    expect(sessionIdFromContext('film-bot', `eden3:s:${SESSION_ID}`)).toBe(SESSION_ID);
    expect(sessionIdFromContext('film-bot', `agent:film-bot:eden3:s:${SESSION_ID}`)).toBe(
      SESSION_ID,
    );
    expect(sessionIdFromContext('film-bot', `agent:other:eden3:s:${SESSION_ID}`)).toBeNull();
    expect(sessionIdFromContext('film-bot', `cron:${SESSION_ID}`)).toBeNull();
  });

  it('binds create to the store-resolved owner/agent and computes the next run', async () => {
    const calls = [];
    const store = {
      resolveIdentity: async (agentId, sessionId) => {
        calls.push(['resolve', agentId, sessionId]);
        return identity;
      },
      create: async (resolved, input) => {
        calls.push(['create', resolved, input]);
        return { id: TASK_ID, status: 'active' };
      },
    };
    const now = new Date('2026-07-31T12:00:00.000Z');
    const result = await handleBridgeRequest(
      request('create', {
        name: 'Daily practice',
        prompt: 'Practice the scene.',
        schedule: { hour: 13, minute: 5, timezone: 'UTC' },
        // Untrusted identity-looking fields are ignored; identity comes only
        // from toolContext + the canonical DB membership lookup.
        ownerId: 'attacker',
        agentAccountId: 'attacker-agent',
      }),
      store,
      { now: () => now },
    );
    expect(result.task).toMatchObject({ id: TASK_ID, status: 'active' });
    expect(calls[0]).toEqual(['resolve', 'film-bot', SESSION_ID]);
    expect(calls[1][1]).toEqual(identity);
    expect(calls[1][2]).toMatchObject({
      name: 'Daily practice',
      prompt: 'Practice the scene.',
      nextScheduledRun: new Date('2026-07-31T13:05:00.000Z'),
    });
    expect(calls[1][2]).not.toHaveProperty('ownerId');
  });

  it('denies a valid-looking context that is not an owner session', async () => {
    await expect(
      handleBridgeRequest(request('list'), { resolveIdentity: async () => null }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('validates updates and publishes the hard ten-enabled-job guard', async () => {
    expect(MAX_ENABLED_TASKS_PER_AGENT).toBe(10);
    expect(MAX_RETAINED_SELF_CRON_TASKS_PER_AGENT).toBe(50);
    await expect(
      handleBridgeRequest(request('update', { taskId: TASK_ID }), {
        resolveIdentity: async () => identity,
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      handleBridgeRequest(
        request('create', {
          name: 'past',
          prompt: 'past',
          schedule: { at: '2026-01-01T00:00:00.000Z' },
        }),
        { resolveIdentity: async () => identity },
        { now: () => new Date('2026-07-31T00:00:00.000Z') },
      ),
    ).rejects.toMatchObject({ code: 'invalid_schedule' });

    await expect(
      handleBridgeRequest(
        request('create', {
          name: 'malformed',
          prompt: 'malformed',
          schedule: { hour: 99, minute: 0, timezone: 'UTC' },
        }),
        { resolveIdentity: async () => identity },
      ),
    ).rejects.toMatchObject({ code: 'invalid_schedule' });

    await expect(
      handleBridgeRequest(
        request('create', {
          name: 'unknown key',
          prompt: 'unknown key',
          schedule: { hour: 9, minute: 0, command: 'cron add' },
        }),
        { resolveIdentity: async () => identity },
      ),
    ).rejects.toMatchObject({ code: 'invalid_schedule' });
  });
});

describe('bridge/API schedule parity', () => {
  const from = new Date('2026-03-07T12:34:56.000Z');
  const cases = [
    { at: '2026-03-07T13:00:00.000Z' },
    { minute: 45, hour: '*', timezone: 'UTC' },
    { minute: '*/15', hour: '8-10', timezone: 'America/New_York' },
    { minute: 30, hour: 9, day_of_week: 4, timezone: 'UTC' },
    { minute: 30, hour: 2, timezone: 'America/New_York' },
    { minute: 5, hour: 7, day: 15, day_of_week: 'mon-fri', month: '1-12' },
  ];

  for (const schedule of cases) {
    it(`matches task-schedule for ${JSON.stringify(schedule)}`, () => {
      expect(bridgeNextOccurrence(schedule, from)?.toISOString() ?? null).toBe(
        apiNextOccurrence(schedule, from)?.toISOString() ?? null,
      );
    });
  }
});

describe('Unix socket client/server framing', () => {
  it('round-trips one bounded JSON frame', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eden3-agent-cron-'));
    const socketPath = path.join(dir, 'cron.sock');
    const server = createBridgeServer(async (payload) => ({ echo: payload.action }));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    sockets.push({ server, dir });

    await expect(requestAgentCron(request('list'), { socketPath })).resolves.toMatchObject({
      protocolVersion: 1,
      ok: true,
      echo: 'list',
    });
  });

  it('keeps the socket open across asynchronous database-like dispatch', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eden3-agent-cron-'));
    const socketPath = path.join(dir, 'cron.sock');
    const server = createBridgeServer(async (payload) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { echo: payload.action };
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    sockets.push({ server, dir });

    await expect(requestAgentCron(request('list'), { socketPath })).resolves.toMatchObject({
      protocolVersion: 1,
      ok: true,
      echo: 'list',
    });
  });

  it('returns narrow structured errors without leaking unexpected failures', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eden3-agent-cron-'));
    const socketPath = path.join(dir, 'cron.sock');
    const server = createBridgeServer(async () => {
      throw new BridgeError('forbidden', 'owner session required');
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    sockets.push({ server, dir });
    await expect(requestAgentCron(request('list'), { socketPath })).resolves.toMatchObject({
      ok: false,
      error: { code: 'forbidden', message: 'owner session required' },
    });
  });
});
