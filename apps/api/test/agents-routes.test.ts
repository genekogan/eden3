import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { credit, resetEnvCache } from '@eden3/core';
import { loadRootEnv, pg } from '@eden3/db';
import type { GatewayTurnEvent } from '@eden3/gateway';
import type { AgentDto } from '@eden3/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../src/server';
import { defaultOpenclawDataDir } from '../src/gateway-glue';
import { reconcileAgentRuntime } from '../src/services/agent-runtime-sync';
import type { ToolsClientLike } from '../src/services/history-sync';
import type { CompatClientLike } from '../src/services/turns';
import {
  deleteFixturesByMarker,
  devCookie,
  insertAgentAccount,
  insertCreation,
  insertUserAccount,
  makeFakeCronSync,
  makeFakeProvisioner,
  makeFakeSkillSync,
  makeFakeToolSync,
  makeMarker,
  type FakeSkillSync,
  type FakeToolSync,
  type FakeProvisioner,
} from './fixtures';

loadRootEnv();

/**
 * Agents API against live Postgres with a FAKE gateway provisioner (the real
 * one is exercised by test/integration/agents-tasks.itest.ts).
 */

const marker = makeMarker('agapi');
let app: FastifyInstance;
let fakeProvisioner: FakeProvisioner;
let fakeSkillSync: FakeSkillSync;
let fakeToolSync: FakeToolSync;
let tmpRoot = '';
let mediaDir = '';
const previousOpenClawDataDir = process.env.OPENCLAW_DATA_DIR;
const chatAgentIds: string[] = [];

/** 1x1 transparent PNG (mirrors the concepts suite). */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function avatarBody(buffer: Buffer, mime = 'image/png', filename = 'avatar.png') {
  return { filename, mime, dataBase64: buffer.toString('base64') };
}

const emptyTools: ToolsClientLike = {
  sessionsHistory: async () => ({
    sessionKey: '',
    messages: [],
    truncated: false,
    contentTruncated: false,
  }),
};

const fakeCompat: CompatClientLike = {
  async *chatTurn(params): AsyncGenerator<GatewayTurnEvent, void, void> {
    // Session-title generation deliberately shares the compat client but runs
    // in an isolated housekeeping session. This probe tracks only the user
    // turn whose immediate availability is the contract under test.
    if (!params.sessionKey.startsWith('eden3:title:')) {
      chatAgentIds.push(params.agentId);
    }
    yield { type: 'turn.started' };
    yield { type: 'token', delta: 'newly-created-ok' };
    yield {
      type: 'turn.completed',
      text: 'newly-created-ok',
      emptyTurn: false,
      finishReason: 'stop',
      usage: {
        promptTokens: 5,
        completionTokens: 3,
        totalTokens: 8,
      },
    };
  },
};

let ownerId = '';
let strangerId = '';
let agentAId = ''; // public, pilot, private persona, 1 public + 1 private creation
let agentBId = ''; // public
const agentA = `${marker}_alpha`;
const agentB = `${marker}_beta`;
const privateAgent = `${marker}_ghost`;

type AgentItem = AgentDto & { creationCount: number; sessionCount: number };
interface AgentsPage {
  items: AgentItem[];
  nextCursor: string | null;
}
interface ProfileBody {
  agent: AgentDto;
  recentCreations: { id: string; url: string | null }[];
}
interface AgentExportBody {
  bundle: {
    kind: 'eden3.agent.bundle';
    version: 1;
    agent: {
      username: string;
      name: string;
      description: string;
      persona: string;
      greeting: string;
      model: string;
      thinkingLevel: string;
      toolGroups: string[];
    };
    memory: { summary: string | null; items: unknown[] };
    skills: unknown[];
  };
}

beforeAll(async () => {
  ownerId = await insertUserAccount(`${marker}_owner`);
  strangerId = await insertUserAccount(`${marker}_str`);
  // Distinct created_at values make the keyset order deterministic.
  agentAId = await insertAgentAccount(agentA, {
    ownerId,
    name: 'Alpha Agent',
    persona: 'top secret persona',
    isPersonaPublic: false,
    isPilot: true,
    public: true,
    createdAt: new Date('2020-01-03T00:00:00Z'),
  });
  agentBId = await insertAgentAccount(agentB, {
    ownerId,
    name: 'Beta Agent',
    public: true,
    createdAt: new Date('2020-01-02T00:00:00Z'),
  });
  await insertAgentAccount(privateAgent, {
    ownerId,
    name: 'Ghost Agent',
    public: false,
    createdAt: new Date('2020-01-01T00:00:00Z'),
  });
  await insertCreation({
    agentId: agentAId,
    userId: ownerId,
    public: true,
    url: 'https://media-one.example.invalid/fixture-a.png',
    createdAt: new Date('2020-02-01T00:00:00Z'),
  });
  await insertCreation({
    agentId: agentAId,
    userId: ownerId,
    public: false,
    createdAt: new Date('2020-02-02T00:00:00Z'),
  });

  // Point the avatar upload's LocalMediaStore (env MEDIA_DIR) at a temp dir
  // before the server (and its /media static mount) boots.
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'eden3-agents-'));
  mediaDir = path.join(tmpRoot, 'media');
  process.env.OPENCLAW_DATA_DIR = path.join(tmpRoot, 'openclaw');
  await mkdir(mediaDir, { recursive: true });
  process.env.MEDIA_DIR = mediaDir;
  resetEnvCache();

  fakeProvisioner = makeFakeProvisioner();
  fakeSkillSync = makeFakeSkillSync();
  fakeToolSync = makeFakeToolSync();
  app = await buildServer({
    gateway: { compat: fakeCompat, tools: emptyTools },
    provisioning: {
      provisioner: fakeProvisioner,
      cronSync: makeFakeCronSync(),
      skillSync: fakeSkillSync,
      toolSync: fakeToolSync,
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await deleteFixturesByMarker(marker);
  await pg.end({ timeout: 5 });
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
  if (previousOpenClawDataDir === undefined) delete process.env.OPENCLAW_DATA_DIR;
  else process.env.OPENCLAW_DATA_DIR = previousOpenClawDataDir;
});

describe('GET /agents (directory)', () => {
  it('lists public agents with counts + is_pilot, hiding private ones', async () => {
    const res = await app.inject({ method: 'GET', url: `/agents?q=${marker}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as AgentsPage;
    const usernames = body.items.map((a) => a.username);
    expect(usernames).toContain(agentA);
    expect(usernames).toContain(agentB);
    expect(usernames).not.toContain(privateAgent);

    const alpha = body.items.find((a) => a.username === agentA)!;
    expect(alpha.isPilot).toBe(true);
    expect(alpha.creationCount).toBe(1); // public creations only
    expect(alpha.sessionCount).toBe(0);
    expect(alpha.persona).toBeNull(); // is_persona_public = false
    expect(alpha.provisionStatus).toBe('pending');
  });

  it('paginates with a keyset cursor (created_at desc)', async () => {
    const page1 = (
      await app.inject({ method: 'GET', url: `/agents?q=${marker}&limit=1` })
    ).json() as AgentsPage;
    expect(page1.items).toHaveLength(1);
    expect(page1.items[0]!.username).toBe(agentA); // newest created_at
    expect(page1.nextCursor).toBeTruthy();

    const page2 = (
      await app.inject({
        method: 'GET',
        url: `/agents?q=${marker}&limit=1&cursor=${encodeURIComponent(page1.nextCursor!)}`,
      })
    ).json() as AgentsPage;
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]!.username).toBe(agentB);
  });

  it('400s on a malformed cursor', async () => {
    const res = await app.inject({ method: 'GET', url: '/agents?cursor=%25garbage' });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /agents?scope=mine (own agents, decided 2026-07-09)', () => {
  it('lists the owner’s agents including private ones, persona visible', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/agents?q=${marker}&scope=mine`,
      headers: { cookie: devCookie(ownerId) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as AgentsPage;
    const usernames = body.items.map((a) => a.username);
    expect(usernames).toContain(agentA);
    expect(usernames).toContain(agentB);
    expect(usernames).toContain(privateAgent);

    // The owner sees their own private persona in mine scope.
    const alpha = body.items.find((a) => a.username === agentA)!;
    expect(alpha.persona).toBe('top secret persona');
  });

  it('never shows another user’s private agents in mine scope', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/agents?q=${marker}&scope=mine`,
      headers: { cookie: devCookie(strangerId) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as AgentsPage;
    expect(body.items).toHaveLength(0);
  });

  it('401s for anonymous viewers', async () => {
    const res = await app.inject({ method: 'GET', url: '/agents?scope=mine' });
    expect(res.statusCode).toBe(401);
  });

  it('keeps private agents out of the default public scope even for their owner’s session', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/agents?q=${marker}`,
      headers: { cookie: devCookie(ownerId) },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as AgentsPage;
    const usernames = body.items.map((a) => a.username);
    expect(usernames).not.toContain(privateAgent);
    // ...and the private persona stays hidden in the public directory.
    const alpha = body.items.find((a) => a.username === agentA)!;
    expect(alpha.persona).toBeNull();
  });
});

describe('GET /agents/:username (profile)', () => {
  it('returns the agent with its recent PUBLIC creations', async () => {
    const res = await app.inject({ method: 'GET', url: `/agents/${agentA}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ProfileBody;
    expect(body.agent.username).toBe(agentA);
    expect(body.agent.persona).toBeNull(); // anonymous viewer
    expect(body.recentCreations).toHaveLength(1);
    expect(body.recentCreations[0]!.url).toBe(
      'https://media-one.example.invalid/fixture-a.png',
    );
  });

  it('reveals the persona to the owner', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/agents/${agentA}`,
      headers: { cookie: devCookie(ownerId) },
    });
    expect((res.json() as ProfileBody).agent.persona).toBe('top secret persona');
  });

  it('resolves usernames case-insensitively (citext)', async () => {
    const res = await app.inject({ method: 'GET', url: `/agents/${agentA.toUpperCase()}` });
    expect(res.statusCode).toBe(200);
  });

  it('404s private agents for anonymous + non-owners, 200 for the owner', async () => {
    expect((await app.inject({ method: 'GET', url: `/agents/${privateAgent}` })).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/agents/${privateAgent}`,
          headers: { cookie: devCookie(strangerId) },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/agents/${privateAgent}`,
          headers: { cookie: devCookie(ownerId) },
        })
      ).statusCode,
    ).toBe(200);
  });

  it('404s unknown agents and user (non-agent) usernames', async () => {
    expect((await app.inject({ method: 'GET', url: `/agents/${marker}_nope` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/agents/${marker}_owner` })).statusCode).toBe(404);
  });
});

describe('POST /agents (create + provision)', () => {
  it('401s anonymous requests', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: { username: `${marker}new`, name: 'New Agent' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns promptly in provisioning state, then the durable worker makes it ready', async () => {
    const username = `${marker}new1`.replace(/_/g, '-'); // path/CLI-safe shape
    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: { cookie: devCookie(ownerId) },
      payload: {
        username,
        name: 'Freshly Made',
        description: 'a test agent',
        persona: 'You are Freshly Made.',
        greeting: 'hello!',
        voice: 'precise and bright',
        model: 'anthropic/claude-sonnet-4-5',
        thinkingLevel: 'deep',
        toolGroups: ['group:runtime', 'group:fs', 'group:media'],
      },
    });
    expect(res.statusCode).toBe(201);
    const { agent } = res.json() as { agent: AgentDto };
    expect(agent.username).toBe(username);
    expect(agent.ownerId).toBe(ownerId);
    expect(agent.public).toBe(true);
    expect(agent.provisionStatus).toBe('provisioning');
    expect(agent.persona).toBe('You are Freshly Made.');
    expect(agent.voice).toBe('precise and bright');
    expect(agent.model).toBe('anthropic/claude-sonnet-4-5');
    expect(agent.thinkingLevel).toBe('deep');
    expect(agent.toolGroups).toEqual(['group:runtime', 'group:fs', 'group:media']);

    expect(fakeProvisioner.provisions.find((p) => p.openclawId === username)).toBeUndefined();
    expect(await app.agentProvisioningWorker.tick()).toBe(1);
    const call = fakeProvisioner.provisions.find((p) => p.openclawId === username);
    expect(call).toBeDefined();
    expect(call!.model).toBe('anthropic/claude-sonnet-4-5');
    expect(call!.thinkingLevel).toBe('deep');
    expect(call!.voice).toBe('precise and bright');
    expect(call!.persona).toBe('You are Freshly Made.');
    // eden-safe-base retired to the platform layer, so a fresh agent syncs no
    // default skills (privacy/safety now live in AGENTS.md + egress controls).
    expect(fakeSkillSync.calls).toContainEqual({
      openclawId: username,
      skills: [],
    });
    expect(fakeToolSync.calls).toContainEqual({
      openclawId: username,
      toolGroups: ['group:runtime', 'group:fs', 'group:media'],
    });

    const [row] = await pg<
      {
        openclaw_id: string;
        provision_status: string;
        workspace_path: string;
        model: string;
        thinking_level: string;
        tool_groups: string[];
        voice: string | null;
      }[]
    >`
      select g.openclaw_id, g.provision_status, g.workspace_path, g.model, g.thinking_level,
             g.tool_groups, g.voice
      from agents g join accounts a on a.id = g.account_id
      where a.username = ${username}
    `;
    expect(row).toMatchObject({
      openclaw_id: username,
      provision_status: 'ready',
      workspace_path: path.join(defaultOpenclawDataDir(), `workspace-${username}`),
      model: 'anthropic/claude-sonnet-4-5',
      thinking_level: 'deep',
      tool_groups: ['group:runtime', 'group:fs', 'group:media'],
      voice: 'precise and bright',
    });
  });

  it('creates a provisioned agent that can receive an immediate first chat turn', async () => {
    const username = `${marker}chat1`.replace(/_/g, '-');
    const createRes = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: { cookie: devCookie(ownerId) },
      payload: {
        username,
        name: 'Chat Ready',
        persona: 'You answer crisply.',
      },
    });
    expect(createRes.statusCode).toBe(201);
    expect((createRes.json() as { agent: AgentDto }).agent.provisionStatus).toBe('provisioning');
    expect(await app.agentProvisioningWorker.tick()).toBe(1);

    await credit({
      accountId: ownerId,
      amount: 100,
      type: 'credit:test',
      idempotencyKey: `${marker}:new-agent-chat:${username}`,
    });
    const before = chatAgentIds.length;
    const chatRes = await app.inject({
      method: 'POST',
      url: '/sessions/new/messages',
      headers: { cookie: devCookie(ownerId) },
      payload: { content: 'hello', agentUsername: username },
    });

    expect(chatRes.statusCode).toBe(200);
    expect(chatAgentIds.slice(before)).toEqual([username]);
    const sessionId = chatRes.headers['x-session-id'];
    expect(typeof sessionId).toBe('string');
    const [assistant] = await pg<{ content: string | null }[]>`
      select content from messages
      where session_id = ${String(sessionId)} and role = 'assistant'
      order by created_at desc limit 1
    `;
    expect(assistant?.content).toBe('newly-created-ok');
  });

  it('429s before insert/provision when the native-agent quota is exhausted', async () => {
    const username = `${marker}quota`.replace(/_/g, '-');
    const beforeCalls = fakeProvisioner.provisions.length;
    const [beforeRow] = await pg<{ count: string }[]>`
      select count(*) from accounts where username = ${username}`;
    const original = process.env.MAX_NATIVE_AGENTS_PER_USER;
    try {
      process.env.MAX_NATIVE_AGENTS_PER_USER = '0';
      resetEnvCache();
      const res = await app.inject({
        method: 'POST',
        url: '/agents',
        headers: { cookie: devCookie(ownerId) },
        payload: { username, name: 'Quota Blocked' },
      });
      expect(res.statusCode).toBe(429);
      expect((res.json() as { error: { code: string } }).error.code).toBe('agent_quota_exceeded');
      expect(fakeProvisioner.provisions).toHaveLength(beforeCalls);
      const [row] = await pg<{ count: string }[]>`
        select count(*) from accounts where username = ${username}`;
      expect(Number(row!.count)).toBe(Number(beforeRow!.count));
    } finally {
      if (original === undefined) delete process.env.MAX_NATIVE_AGENTS_PER_USER;
      else process.env.MAX_NATIVE_AGENTS_PER_USER = original;
      resetEnvCache();
    }
  });

  it('409s a duplicate username (case-insensitive)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      headers: { cookie: devCookie(ownerId) },
      payload: { username: agentA.toUpperCase(), name: 'Copycat' },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('username_taken');
  });

  it('400s invalid usernames (shape is the OpenClaw id shape)', async () => {
    for (const username of ['Bad Name', 'ab', '-leading', 'main', 'builder', 'x'.repeat(33)]) {
      const res = await app.inject({
        method: 'POST',
        url: '/agents',
        headers: { cookie: devCookie(ownerId) },
        payload: { username, name: 'Nope' },
      });
      expect(res.statusCode, username).toBe(400);
    }
  });

  it('lets only the owner idempotently requeue a terminal failed build', async () => {
    const failing = makeFakeProvisioner({ failProvision: true });
    const username = `${marker}fail`.replace(/_/g, '-');
    const app2 = await buildServer({
      provisioning: { provisioner: failing },
      agentProvisioning: { maxAttempts: 1 },
    });
    try {
      const res = await app2.inject({
        method: 'POST',
        url: '/agents',
        headers: { cookie: devCookie(ownerId) },
        payload: { username, name: 'Doomed' },
      });
      expect(res.statusCode).toBe(201);
      expect((res.json() as { agent: AgentDto }).agent.provisionStatus).toBe('provisioning');
      expect(await app2.agentProvisioningWorker.tick()).toBe(1);
      const status = await app2.inject({
        method: 'GET',
        url: `/agents/${username}`,
        headers: { cookie: devCookie(ownerId) },
      });
      expect((status.json() as { agent: AgentDto }).agent.provisionStatus).toBe('failed');
    } finally {
      await app2.close();
    }

    const strangerRetry = await app.inject({
      method: 'POST',
      url: `/agents/${username}/retry-provision`,
      headers: { cookie: devCookie(strangerId) },
    });
    expect(strangerRetry.statusCode, strangerRetry.body).toBe(403);

    const retries = await Promise.all(
      [0, 1].map(() =>
        app.inject({
          method: 'POST',
          url: `/agents/${username}/retry-provision`,
          headers: { cookie: devCookie(ownerId) },
        }),
      ),
    );
    expect(retries.map((response) => response.statusCode).sort()).toEqual([200, 202]);
    for (const response of retries) {
      expect(response.json()).toMatchObject({ ok: true, status: 'provisioning', queued: true });
    }

    const [queued] = await pg<
      { provision_status: string; state: string; attempt_count: number; failure_notices: number }[]
    >`
      select g.provision_status, j.state, j.attempt_count,
             (select count(*)::int from app_notifications n
              where n.account_id = ${ownerId}
                and n.source_agent_id = a.id
                and n.kind = 'agent_build_failed') as failure_notices
      from accounts a
      join agents g on g.account_id = a.id
      join agent_provision_jobs j on j.agent_account_id = a.id
      where a.username = ${username}
    `;
    expect(queued).toMatchObject({
      provision_status: 'provisioning',
      state: 'pending',
      attempt_count: 0,
      failure_notices: 0,
    });

    expect(await app.agentProvisioningWorker.tick()).toBe(1);
    const ready = await app.inject({
      method: 'GET',
      url: `/agents/${username}`,
      headers: { cookie: devCookie(ownerId) },
    });
    expect((ready.json() as { agent: AgentDto }).agent.provisionStatus).toBe('ready');

    // Import and dormant first-chat failures predate durable provision jobs.
    // Two owner retries against that valid no-job state still create one cycle.
    const legacyUsername = `${marker}legacyfail`.replace(/_/g, '-');
    const legacyId = await insertAgentAccount(legacyUsername, {
      ownerId,
      openclawId: legacyUsername,
      provisionStatus: 'failed',
    });
    const legacyRetries = await Promise.all(
      [0, 1].map(() =>
        app.inject({
          method: 'POST',
          url: `/agents/${legacyUsername}/retry-provision`,
          headers: { cookie: devCookie(ownerId) },
        }),
      ),
    );
    expect(legacyRetries.map((response) => response.statusCode).sort()).toEqual([200, 202]);
    const [legacyJob] = await pg<{ state: string; count: number }[]>`
      select min(state) as state, count(*)::int as count
      from agent_provision_jobs
      where agent_account_id = ${legacyId}
    `;
    expect(legacyJob).toEqual({ state: 'pending', count: 1 });
    expect(await app.agentProvisioningWorker.tick()).toBe(1);
  });
});

describe('agent export/import', () => {
  it('exports a portable owner-only bundle', async () => {
    const owner = await app.inject({
      method: 'GET',
      url: `/agents/${agentA}/export`,
      headers: { cookie: devCookie(ownerId) },
    });
    expect(owner.statusCode).toBe(200);
    expect(owner.headers['content-disposition']).toContain(`${agentA}-eden3-agent.json`);
    const { bundle } = owner.json() as AgentExportBody;
    expect(bundle.kind).toBe('eden3.agent.bundle');
    expect(bundle.version).toBe(1);
    expect(bundle.agent).toMatchObject({
      username: agentA,
      name: 'Alpha Agent',
      persona: 'top secret persona',
      model: 'anthropic/claude-haiku-4-5',
      thinkingLevel: 'balanced',
      toolGroups: [
        'group:runtime',
        'group:fs',
        'group:web',
        'group:sessions',
        'group:memory',
        'group:media',
        'group:ui',
        'group:automation',
        'group:agents',
        'group:plugins',
      ],
    });
    expect(bundle.memory.items).toEqual([]);
    expect(bundle.skills).toEqual([]);

    const stranger = await app.inject({
      method: 'GET',
      url: `/agents/${agentA}/export`,
      headers: { cookie: devCookie(strangerId) },
    });
    expect(stranger.statusCode).toBe(403);
  });

  it('imports an exported bundle into an equivalent provisioned agent', async () => {
    const exported = await app.inject({
      method: 'GET',
      url: `/agents/${agentA}/export`,
      headers: { cookie: devCookie(ownerId) },
    });
    const bundle = (exported.json() as AgentExportBody).bundle;
    const username = `${marker}import`.replace(/_/g, '-').slice(0, 32);
    const res = await app.inject({
      method: 'POST',
      url: '/agents/import',
      headers: { cookie: devCookie(ownerId) },
      payload: { username, bundle },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      agent: AgentDto;
      imported: { bundleVersion: number; sourceUsername: string; skills: number; memoryItems: number };
    };
    expect(body.agent).toMatchObject({
      username,
      name: 'Alpha Agent',
      description: null,
      persona: 'top secret persona',
      public: true,
      provisionStatus: 'ready',
    });
    expect(body.imported).toMatchObject({
      bundleVersion: 1,
      sourceUsername: agentA,
      skills: 0,
      memoryItems: 0,
    });

    const call = fakeProvisioner.provisions.find((p) => p.openclawId === username);
    expect(call).toBeDefined();
    expect(call!.persona).toBe('top secret persona');
    expect(call!.model).toBe('anthropic/claude-haiku-4-5');
    // eden-safe-base retired to the platform layer, so a fresh agent syncs no
    // default skills (privacy/safety now live in AGENTS.md + egress controls).
    expect(fakeSkillSync.calls).toContainEqual({
      openclawId: username,
      skills: [],
    });
    expect(fakeToolSync.calls).toContainEqual({
      openclawId: username,
      toolGroups: [
        'group:runtime',
        'group:fs',
        'group:web',
        'group:sessions',
        'group:memory',
        'group:media',
        'group:ui',
        'group:automation',
        'group:agents',
        'group:plugins',
      ],
    });
  });
});

describe('PATCH /agents/:username (owner edit + hot re-render)', () => {
  it('401s anonymous and 403s non-owners', async () => {
    expect(
      (
        await app.inject({ method: 'PATCH', url: `/agents/${agentA}`, payload: { name: 'X' } })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/agents/${agentA}`,
          headers: { cookie: devCookie(strangerId) },
          payload: { name: 'X' },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('updates fields and hot re-renders the persona when provisioned', async () => {
    // Only a ready row pointing at its derived canonical workspace is live.
    const canonicalWorkspace = path.join(defaultOpenclawDataDir(), `workspace-${agentB}`);
    await pg`
      update agents
      set openclaw_id = ${agentB}, workspace_path = ${canonicalWorkspace}, provision_status = 'ready'
      where account_id = ${agentBId}
    `;
    const res = await app.inject({
      method: 'PATCH',
      url: `/agents/${agentB}`,
      headers: { cookie: devCookie(ownerId) },
      payload: {
        name: 'Beta Renamed',
        persona: 'a new soul',
        greeting: 'yo',
        voice: 'low and careful',
        model: 'anthropic/claude-opus-4-6',
        thinkingLevel: 'deep',
        toolGroups: ['group:runtime', 'group:media'],
      },
    });
    expect(res.statusCode).toBe(200);
    const { agent } = res.json() as { agent: AgentDto };
    expect(agent.name).toBe('Beta Renamed');
    expect(agent.persona).toBe('a new soul');
    expect(agent.voice).toBe('low and careful');
    expect(agent.model).toBe('anthropic/claude-opus-4-6');
    expect(agent.thinkingLevel).toBe('deep');
    expect(agent.toolGroups).toEqual(['group:runtime', 'group:media']);

    const update = fakeProvisioner.personaUpdates.find((p) => p.openclawId === agentB);
    expect(update).toBeDefined();
    expect(update!.persona).toBe('a new soul');
    expect(update!.name).toBe('Beta Renamed');
    expect(update!.greeting).toBe('yo');
    expect(update!.voice).toBe('low and careful');
    expect(update!.thinkingLevel).toBe('deep');
    const modelUpdate = fakeProvisioner.provisions
      .filter((p) => p.openclawId === agentB)
      .at(-1);
    expect(modelUpdate).toMatchObject({
      model: 'anthropic/claude-opus-4-6',
      voice: 'low and careful',
      thinkingLevel: 'deep',
    });
    expect(fakeToolSync.calls).toContainEqual({
      openclawId: agentB,
      toolGroups: ['group:runtime', 'group:media'],
    });
  });

  it('hot re-renders when thinkingLevel is the only persona field changed', async () => {
    const beforeUpdates = fakeProvisioner.personaUpdates.length;
    const res = await app.inject({
      method: 'PATCH',
      url: `/agents/${agentB}`,
      headers: { cookie: devCookie(ownerId) },
      payload: { thinkingLevel: 'fast' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { agent: AgentDto }).agent.thinkingLevel).toBe('fast');
    expect(fakeProvisioner.personaUpdates).toHaveLength(beforeUpdates + 1);
    expect(fakeProvisioner.personaUpdates.at(-1)).toMatchObject({
      openclawId: agentB,
      thinkingLevel: 'fast',
    });
  });

  it('persists edits without hot-updating failed or non-canonical agents', async () => {
    const failedUsername = `${marker}_failed_edit`;
    const failedId = await insertAgentAccount(failedUsername, {
      ownerId,
      name: 'Failed Edit Agent',
      openclawId: failedUsername,
      workspacePath: path.join(defaultOpenclawDataDir(), `workspace-${failedUsername}`),
      provisionStatus: 'failed',
    });
    const nonCanonicalUsername = `${marker}_wrong_ws`;
    const nonCanonicalId = await insertAgentAccount(nonCanonicalUsername, {
      ownerId,
      name: 'Wrong Workspace Agent',
      openclawId: nonCanonicalUsername,
      workspacePath: `/tmp/non-canonical-${nonCanonicalUsername}`,
      provisionStatus: 'ready',
    });
    const beforePersona = fakeProvisioner.personaUpdates.length;
    const beforeProvisions = fakeProvisioner.provisions.length;
    const beforeTools = fakeToolSync.calls.length;

    for (const username of [failedUsername, nonCanonicalUsername]) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/agents/${username}`,
        headers: { cookie: devCookie(ownerId) },
        payload: {
          persona: `saved for ${username}`,
          model: 'anthropic/claude-opus-4-6',
          thinkingLevel: 'deep',
          toolGroups: ['group:runtime'],
        },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { agent: AgentDto }).agent).toMatchObject({
        persona: `saved for ${username}`,
        model: 'anthropic/claude-opus-4-6',
        thinkingLevel: 'deep',
        toolGroups: ['group:runtime'],
      });
    }
    expect(fakeProvisioner.personaUpdates).toHaveLength(beforePersona);
    expect(fakeProvisioner.provisions).toHaveLength(beforeProvisions);
    expect(fakeToolSync.calls).toHaveLength(beforeTools);
    const rows = await pg<{ account_id: string; persona: string | null }[]>`
      select account_id, persona from agents
      where account_id in (${failedId}, ${nonCanonicalId})
    `;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.persona?.startsWith('saved for '))).toBe(true);
  });

  it('never mutates runtime before the authoritative DB revision commits', async () => {
    const username = `${marker}_converge`;
    const accountId = await insertAgentAccount(username, {
      ownerId,
      name: 'Converge Agent',
      persona: 'database persona',
      greeting: 'before concurrent edit',
      openclawId: username,
      workspacePath: path.join(defaultOpenclawDataDir(), `workspace-${username}`),
      provisionStatus: 'ready',
    });
    const convergingProvisioner = makeFakeProvisioner();
    const app2 = await buildServer({ provisioning: { provisioner: convergingProvisioner } });
    try {
      const res = await app2.inject({
        method: 'PATCH',
        url: `/agents/${username}`,
        headers: { cookie: devCookie(ownerId) },
        payload: { persona: 'runtime mutation before SQL failure\u0000' },
      });
      expect(res.statusCode).toBe(500);
      expect(convergingProvisioner.personaUpdates).toHaveLength(0);
      expect(convergingProvisioner.provisions).toHaveLength(0);
      const [current] = await pg<{ persona: string | null; greeting: string | null }[]>`
        select persona, greeting from agents where account_id = ${accountId}
      `;
      expect(current).toEqual({
        persona: 'database persona',
        greeting: 'before concurrent edit',
      });
    } finally {
      await app2.close();
    }
  });

  it('durably retries a failed partial runtime write from the newest committed row', async () => {
    const canonicalWorkspace = path.join(defaultOpenclawDataDir(), `workspace-${agentB}`);
    await pg`
      update agents
      set openclaw_id = ${agentB}, workspace_path = ${canonicalWorkspace}, provision_status = 'ready'
      where account_id = ${agentBId}
    `;
    const rejectingProvisioner = makeFakeProvisioner({ failPersonaUpdate: true });
    const rejectingTools = makeFakeToolSync();
    const app2 = await buildServer({
      provisioning: { provisioner: rejectingProvisioner, toolSync: rejectingTools },
    });
    try {
      const res = await app2.inject({
        method: 'PATCH',
        url: `/agents/${agentB}`,
        headers: { cookie: devCookie(ownerId) },
        payload: { name: 'Must Not Commit', persona: 'This runtime edit is rejected.' },
      });
      expect(res.statusCode).toBe(200);
      const [pending] = await pg<{
        name: string | null;
        persona: string | null;
        runtime_sync_version: number;
        runtime_synced_version: number;
        runtime_sync_error: string | null;
      }[]>`
        select name, persona, runtime_sync_version, runtime_synced_version,
               runtime_sync_error
        from agents where account_id = ${agentBId}
      `;
      expect(pending).toMatchObject({
        name: 'Must Not Commit',
        persona: 'This runtime edit is rejected.',
        runtime_sync_version: pending!.runtime_synced_version + 1,
      });
      expect(pending!.runtime_sync_error).toContain('retry pending');
      expect(rejectingProvisioner.personaUpdates).toHaveLength(1);

      const healthyProvisioner = makeFakeProvisioner();
      const healthyTools = makeFakeToolSync();
      await pg`
        update agents
        set runtime_sync_lease_expires_at = now() - interval '1 second'
        where account_id = ${agentBId}
      `;
      await expect(
        reconcileAgentRuntime(agentBId, {
          provisioner: healthyProvisioner,
          toolSync: healthyTools,
        }),
      ).resolves.toMatchObject({
        status: 'synced',
        version: pending!.runtime_sync_version,
      });
      expect(healthyProvisioner.personaUpdates.at(-1)).toMatchObject({
        openclawId: agentB,
        name: 'Must Not Commit',
        persona: 'This runtime edit is rejected.',
      });
      const [recovered] = await pg<{
        runtime_sync_version: number;
        runtime_synced_version: number;
        runtime_sync_error: string | null;
      }[]>`
        select runtime_sync_version, runtime_synced_version, runtime_sync_error
        from agents where account_id = ${agentBId}
      `;
      expect(recovered).toEqual({
        runtime_sync_version: pending!.runtime_sync_version,
        runtime_synced_version: pending!.runtime_sync_version,
        runtime_sync_error: null,
      });
    } finally {
      await app2.close();
    }
  });

  it('rejects unknown fields and empty patches', async () => {
    for (const payload of [{}, { nonsense: true }]) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/agents/${agentB}`,
        headers: { cookie: devCookie(ownerId) },
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('404s unknown agents', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/agents/${marker}_missing`,
      headers: { cookie: devCookie(ownerId) },
      payload: { name: 'X' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('lets the owner toggle visibility; a private agent vanishes for strangers', async () => {
    // Hide agentB…
    const hide = await app.inject({
      method: 'PATCH',
      url: `/agents/${agentB}`,
      headers: { cookie: devCookie(ownerId) },
      payload: { public: false },
    });
    expect(hide.statusCode).toBe(200);
    expect((hide.json() as { agent: AgentDto }).agent.public).toBe(false);

    // …strangers get a 404 profile and the public directory drops the row…
    expect(
      (await app.inject({ method: 'GET', url: `/agents/${agentB}` })).statusCode,
    ).toBe(404);
    const dir = (
      await app.inject({ method: 'GET', url: `/agents?q=${marker}` })
    ).json() as AgentsPage;
    expect(dir.items.map((a) => a.username)).not.toContain(agentB);

    // …while the owner still sees it in mine scope and can re-publish.
    const mine = (
      await app.inject({
        method: 'GET',
        url: `/agents?q=${marker}&scope=mine`,
        headers: { cookie: devCookie(ownerId) },
      })
    ).json() as AgentsPage;
    expect(mine.items.map((a) => a.username)).toContain(agentB);

    const show = await app.inject({
      method: 'PATCH',
      url: `/agents/${agentB}`,
      headers: { cookie: devCookie(ownerId) },
      payload: { public: true },
    });
    expect(show.statusCode).toBe(200);
    expect((show.json() as { agent: AgentDto }).agent.public).toBe(true);
  });
});

describe('POST /agents/:username/repair (owner runtime re-assert)', () => {
  it('re-provisions a provisioned agent and syncs skills', async () => {
    // agentB was given an openclaw_id by the PATCH suite; ensure it here too.
    await pg`
      update agents
      set openclaw_id = ${agentB},
          workspace_path = ${path.join(defaultOpenclawDataDir(), `workspace-${agentB}`)},
          provision_status = 'ready'
      where account_id = ${agentBId}
    `;
    const before = fakeProvisioner.provisions.length;
    const res = await app.inject({
      method: 'POST',
      url: `/agents/${agentB}/repair`,
      headers: { cookie: devCookie(ownerId) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, repaired: agentB, runtimeSync: 'synced' });
    expect(fakeProvisioner.provisions.length).toBeGreaterThan(before);
    expect(fakeProvisioner.provisions.at(-1)).toMatchObject({ openclawId: agentB });
  });

  it('401s anon, 403s non-owners, 404s unknown', async () => {
    expect(
      (await app.inject({ method: 'POST', url: `/agents/${agentB}/repair` })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/agents/${agentB}/repair`,
          headers: { cookie: devCookie(strangerId) },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/agents/${marker}_nope/repair`,
          headers: { cookie: devCookie(ownerId) },
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('GET /agents/:username/activity (owner logs peek)', () => {
  it('returns recent usage events for the owner and gates non-owners', async () => {
    // A visible usage row for agentA.
    await pg`
      insert into usage_events (event_type, status, user_id, agent_id, provider, model, manna, latency_ms)
      values ('chat_turn', 'completed', ${ownerId}, ${agentAId}, 'anthropic', 'claude-haiku-4-5', 5, 120)
    `;
    const ok = await app.inject({
      method: 'GET',
      url: `/agents/${agentA}/activity`,
      headers: { cookie: devCookie(ownerId) },
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as { items: Array<{ eventType: string; status: string; manna: number | null }> };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0]).toMatchObject({ eventType: 'chat_turn' });

    expect(
      (await app.inject({ method: 'GET', url: `/agents/${agentA}/activity` })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/agents/${agentA}/activity`,
          headers: { cookie: devCookie(strangerId) },
        })
      ).statusCode,
    ).toBe(403);
  });
});

describe('avatar upload (POST/DELETE /agents/:username/avatar)', () => {
  it('lets the owner upload an avatar and sets accounts.user_image', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/agents/${agentB}/avatar`,
      headers: { cookie: devCookie(ownerId) },
      payload: avatarBody(PNG_1PX, 'image/png', 'face.png'),
    });
    expect(res.statusCode).toBe(200);
    const { agent } = res.json() as { agent: AgentDto };
    expect(agent.userImage).toMatch(/^\/media\/[0-9a-f]{64}\.png$/);

    const [row] = await pg<{
      user_image: string | null;
      state: string;
      owner_account_id: string;
      agent_account_id: string;
      url: string;
      sha256: string;
    }[]>`
      select a.user_image,av.state,av.owner_account_id,av.agent_account_id,av.url,av.sha256
      from accounts a join agent_avatar_assets av on av.agent_account_id=a.id
      where a.id=${agentBId} and av.state='current'
    `;
    expect(row).toMatchObject({
      user_image: agent.userImage,
      state: 'current',
      owner_account_id: ownerId,
      agent_account_id: agentBId,
      url: agent.userImage,
    });
    expect(row!.user_image).toContain(row!.sha256);
  });

  it('retires the exact prior avatar locator when a replacement becomes current', async () => {
    const replacement = Buffer.concat([PNG_1PX, Buffer.from([0x42])]);
    const res = await app.inject({
      method: 'POST',
      url: `/agents/${agentB}/avatar`,
      headers: { cookie: devCookie(ownerId) },
      payload: avatarBody(replacement, 'image/png', 'replacement.png'),
    });
    expect(res.statusCode).toBe(200);
    const rows = await pg<{ state: string; retired_at: Date | null; url: string }[]>`
      select state,retired_at,url from agent_avatar_assets
      where agent_account_id=${agentBId} order by created_at,id`;
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.state === 'current')).toHaveLength(1);
    expect(rows.filter((row) => row.state === 'retired')).toHaveLength(1);
    expect(rows.find((row) => row.state === 'retired')?.retired_at).not.toBeNull();
    expect((res.json() as { agent: AgentDto }).agent.userImage)
      .toBe(rows.find((row) => row.state === 'current')?.url);
  });

  it('401s anonymous and 403s strangers', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/agents/${agentB}/avatar`,
          payload: avatarBody(PNG_1PX),
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/agents/${agentB}/avatar`,
          headers: { cookie: devCookie(strangerId) },
          payload: avatarBody(PNG_1PX),
        })
      ).statusCode,
    ).toBe(403);
  });

  it('rejects unsupported mime, oversized files, and non-image bytes', async () => {
    const badMime = await app.inject({
      method: 'POST',
      url: `/agents/${agentB}/avatar`,
      headers: { cookie: devCookie(ownerId) },
      payload: avatarBody(PNG_1PX, 'image/gif'),
    });
    expect(badMime.statusCode).toBe(400);
    expect((badMime.json() as { error: { code: string } }).error.code).toBe(
      'unsupported_image_type',
    );

    const oversized = await app.inject({
      method: 'POST',
      url: `/agents/${agentB}/avatar`,
      headers: { cookie: devCookie(ownerId) },
      payload: avatarBody(Buffer.alloc(8 * 1024 * 1024 + 1), 'image/png'),
    });
    expect(oversized.statusCode).toBe(400);
    expect((oversized.json() as { error: { code: string } }).error.code).toBe('image_too_large');

    const garbage = await app.inject({
      method: 'POST',
      url: `/agents/${agentB}/avatar`,
      headers: { cookie: devCookie(ownerId) },
      payload: avatarBody(Buffer.from('definitely not an image'), 'image/png'),
    });
    expect(garbage.statusCode).toBe(400);
    expect((garbage.json() as { error: { code: string } }).error.code).toBe('invalid_image_data');
  });

  it('clears the avatar on DELETE (owner ok, stranger 403)', async () => {
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/agents/${agentB}/avatar`,
          headers: { cookie: devCookie(strangerId) },
        })
      ).statusCode,
    ).toBe(403);

    const res = await app.inject({
      method: 'DELETE',
      url: `/agents/${agentB}/avatar`,
      headers: { cookie: devCookie(ownerId) },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { agent: AgentDto }).agent.userImage).toBeNull();

    const [row] = await pg<{ user_image: string | null }[]>`
      select user_image from accounts where id = ${agentBId}
    `;
    expect(row!.user_image).toBeNull();
    const [avatarState] = await pg<{ current: number; retired: number }[]>`
      select count(*) filter (where state='current')::int current,
        count(*) filter (where state='retired')::int retired
      from agent_avatar_assets where agent_account_id=${agentBId}`;
    expect(avatarState).toEqual({ current: 0, retired: 2 });
  });

  it('404s unknown agents and hides private agents from strangers', async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/agents/${marker}_nope/avatar`,
          headers: { cookie: devCookie(ownerId) },
          payload: avatarBody(PNG_1PX),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/agents/${privateAgent}/avatar`,
          headers: { cookie: devCookie(strangerId) },
          payload: avatarBody(PNG_1PX),
        })
      ).statusCode,
    ).toBe(404);
  });
});
