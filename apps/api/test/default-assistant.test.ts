import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadRootEnv, pg } from '@eden3/db';
import type { AgentDto } from '@eden3/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../src/server';
import {
  DEFAULT_EDEN_OPENCLAW_ID,
  DEFAULT_EDEN_USERNAME,
  ensureDefaultEdenAssistant,
  syncDefaultEdenWorkspace,
} from '../src/services/default-assistant';

loadRootEnv();

let app: FastifyInstance;

beforeAll(async () => {
  await ensureDefaultEdenAssistant();
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await pg.end({ timeout: 5 });
});

describe('default Eden assistant', () => {
  it('bootstraps @eden as a public ready assistant backed by OpenClaw main', async () => {
    const [row] = await pg<
      { username: string; openclawId: string | null; status: string; public: boolean; ownerId: string | null }[]
    >`
      select a.username::text as username, g.openclaw_id as "openclawId",
             g.provision_status as status, g.public, g.owner_id as "ownerId"
      from accounts a
      join agents g on g.account_id = a.id
      where a.username = ${DEFAULT_EDEN_USERNAME}
    `;
    expect(row).toMatchObject({
      username: DEFAULT_EDEN_USERNAME,
      openclawId: DEFAULT_EDEN_OPENCLAW_ID,
      status: 'ready',
      public: true,
      ownerId: null,
    });
  });

  it('exposes the assistant profile for every user-facing agent surface', async () => {
    const res = await app.inject({ method: 'GET', url: `/agents/${DEFAULT_EDEN_USERNAME}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { agent: AgentDto; recentCreations: unknown[] };
    expect(body.agent).toMatchObject({
      username: DEFAULT_EDEN_USERNAME,
      name: 'Eden',
      public: true,
      provisionStatus: 'ready',
      isPilot: true,
    });
    expect(body.agent.description).toContain('default Eden assistant');
    expect(body.agent.persona).toContain('create and refine agents');
    expect(body.agent.persona).toContain('/agents/new');
    expect(body.agent.persona).toContain('/agents/builder');
    expect(body.agent.greeting).toContain('configure agents');
  });

  it('syncs OpenClaw main workspace with Eden3-native agent-creation guidance', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eden3-default-eden-'));
    try {
      await fs.writeFile(
        path.join(dataDir, 'openclaw.json'),
        JSON.stringify({ agents: { list: [{ id: DEFAULT_EDEN_OPENCLAW_ID }] } }, null, 2),
        'utf8',
      );
      const result = await syncDefaultEdenWorkspace({
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
      expect(identity).toContain('Handle: @eden');
      expect(state.setupCompletedAt).toBe('2026-07-07T00:00:00.000Z');
      await expect(fs.access(path.join(result.workspaceDir, 'BOOTSTRAP.md'))).rejects.toThrow();
      expect(config.agents.list[0]).toMatchObject({
        id: DEFAULT_EDEN_OPENCLAW_ID,
        name: 'Eden',
        workspace: path.join(dataDir, 'workspace'),
      });
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
