import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DevAuthProvider } from '@eden3/core';
import { loadRootEnv, pg } from '@eden3/db';
import type { AgentDto } from '@eden3/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../src/server';
import {
  DEFAULT_EVE_OPENCLAW_ID,
  DEFAULT_EVE_USERNAME,
  ensureEveAssistant,
  syncEveWorkspace,
} from '../src/services/default-assistant';
import { deleteFixturesByMarker, devCookie, insertUserAccount, makeMarker } from './fixtures';

loadRootEnv();

let app: FastifyInstance;
const marker = makeMarker('eve');
let adminId = '';

beforeAll(async () => {
  adminId = await insertUserAccount(`${marker}_admin`);
  await ensureEveAssistant();
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

describe('platform-owned Eve assistant', () => {
  it('converges concurrent provisioning on one @eve identity backed by OpenClaw main', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => ensureEveAssistant()));
    expect(new Set(results.map((result) => result.accountId)).size).toBe(1);

    const [row] = await pg<
      { username: string; openclawId: string | null; status: string; public: boolean; ownerId: string | null }[]
    >`
      select a.username::text as username, g.openclaw_id as "openclawId",
             g.provision_status as status, g.public, g.owner_id as "ownerId"
      from accounts a
      join agents g on g.account_id = a.id
      where a.username = ${DEFAULT_EVE_USERNAME}
    `;
    expect(row).toMatchObject({
      username: DEFAULT_EVE_USERNAME,
      openclawId: DEFAULT_EVE_OPENCLAW_ID,
      status: 'ready',
      public: true,
      ownerId: null,
    });
  });

  it('exposes the assistant profile for every user-facing agent surface', async () => {
    const res = await app.inject({ method: 'GET', url: `/agents/${DEFAULT_EVE_USERNAME}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { agent: AgentDto; recentCreations: unknown[] };
    expect(body.agent).toMatchObject({
      username: DEFAULT_EVE_USERNAME,
      name: 'Eve',
      public: true,
      provisionStatus: 'ready',
      isPilot: true,
    });
    expect(body.agent.description).toContain('platform-owned Eden assistant');
    expect(body.agent.persona).toContain('create and refine agents');
    expect(body.agent.persona).toContain('/agents/new');
    expect(body.agent.persona).toContain('/agents/builder');
    expect(body.agent.greeting).toContain('configure agents');
  });

  it('denies generic configuration aliases even to an administrator', async () => {
    const cookie = devCookie(adminId);
    const attempts = [
      app.inject({
        method: 'PATCH',
        url: `/agents/${DEFAULT_EVE_USERNAME}`,
        headers: { cookie },
        payload: { name: 'Not Eve' },
      }),
      app.inject({
        method: 'GET',
        url: `/agents/${DEFAULT_EVE_USERNAME}/workspace`,
        headers: { cookie },
      }),
      app.inject({
        method: 'GET',
        url: `/agents/${DEFAULT_EVE_USERNAME}/export`,
        headers: { cookie },
      }),
      app.inject({
        method: 'POST',
        url: `/agents/${DEFAULT_EVE_USERNAME}/skills`,
        headers: { cookie },
        payload: { slugs: [] },
      }),
      app.inject({
        method: 'POST',
        url: '/agents',
        headers: { cookie },
        payload: { username: DEFAULT_EVE_USERNAME, name: 'Second Eve' },
      }),
      app.inject({
        method: 'POST',
        url: '/tasks',
        headers: { cookie },
        payload: {
          agentUsername: DEFAULT_EVE_USERNAME,
          name: 'Configure Eve indirectly',
          prompt: 'This must never run',
          schedule: { at: '2099-01-01T00:00:00.000Z' },
        },
      }),
    ];
    const responses = await Promise.all(attempts);
    expect(responses.map((response) => response.statusCode)).toEqual([
      403,
      403,
      403,
      403,
      400,
      403,
    ]);
  });

  it('syncs OpenClaw main with Eve\'s complete seven-file doctrine', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eden3-eve-'));
    try {
      await fs.writeFile(
        path.join(dataDir, 'openclaw.json'),
        JSON.stringify({ agents: { list: [{ id: DEFAULT_EVE_OPENCLAW_ID }] } }, null, 2),
        'utf8',
      );
      const result = await syncEveWorkspace({
        dataDir,
        now: () => new Date('2026-07-07T00:00:00.000Z'),
      });
      const soul = await fs.readFile(path.join(result.workspaceDir, 'SOUL.md'), 'utf8');
      const identity = await fs.readFile(path.join(result.workspaceDir, 'IDENTITY.md'), 'utf8');
      const state = JSON.parse(
        await fs.readFile(path.join(result.workspaceDir, 'openclaw-workspace-state.json'), 'utf8'),
      ) as { setupCompletedAt?: string };
      const config = JSON.parse(await fs.readFile(path.join(dataDir, 'openclaw.json'), 'utf8')) as {
        agents: { list: Array<Record<string, unknown>> };
      };

      expect(soul).toContain('Create agent at /agents/new');
      expect(soul).toContain('Agent builder at /agents/builder');
      expect(soul).not.toContain('openclaw agents add');
      expect(identity).toContain('Handle: @eve');
      expect(result.filesWritten).toEqual(
        expect.arrayContaining([
          'AGENTS.md',
          'HEARTBEAT.md',
          'IDENTITY.md',
          'MEMORY.md',
          'SOUL.md',
          'TOOLS.md',
          'USER.md',
        ]),
      );
      expect(state.setupCompletedAt).toBe('2026-07-07T00:00:00.000Z');
      await expect(fs.access(path.join(result.workspaceDir, 'BOOTSTRAP.md'))).rejects.toThrow();
      expect(config.agents.list[0]).toMatchObject({
        id: DEFAULT_EVE_OPENCLAW_ID,
        name: 'Eve',
        workspace: path.join(dataDir, 'workspace'),
      });
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
