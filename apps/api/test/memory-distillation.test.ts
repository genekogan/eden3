import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { pg } from '@eden3/db';
import { describe, expect, it } from 'vitest';

import { buildServer } from '../src/server';
import {
  agentMemoryStatus,
  distillAgentMemory,
  MANUAL_MEMORY_MODEL,
  MEMORY_DISTILLATION_MODEL,
} from '../src/services/memory-distillation';
import {
  deleteFixturesByMarker,
  insertAgentAccount,
  insertUserAccount,
  makeFakeCronSync,
  makeFakeProvisioner,
  makeFakeSkillSync,
  makeFakeToolSync,
  makeMarker,
} from './fixtures';

async function tempWorkspace(marker: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `${marker}-workspace-`));
}

async function insertSessionWithMessages(params: {
  ownerId: string;
  agentId: string;
  title: string;
  messages: Array<{ senderId: string; role: string; content: string; createdAt: Date }>;
}): Promise<string> {
  const [session] = await pg<{ id: string }[]>`
    insert into sessions (owner_id, title, session_type, last_message_at)
    values (${params.ownerId}, ${params.title}, 'chat', ${params.messages.at(-1)?.createdAt.toISOString() ?? new Date().toISOString()})
    returning id
  `;
  const sessionId = session!.id;
  await pg`insert into session_agents (session_id, agent_account_id) values (${sessionId}, ${params.agentId})`;
  await pg`insert into session_users (session_id, user_account_id) values (${sessionId}, ${params.ownerId})`;
  for (const message of params.messages) {
    await pg`
      insert into messages (session_id, sender_id, role, content, created_at)
      values (${sessionId}, ${message.senderId}, ${message.role}, ${message.content}, ${message.createdAt.toISOString()})
    `;
  }
  return sessionId;
}

async function waitForDistillDone(openclawId: string): Promise<void> {
  let lastStatus = 'missing';
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const [row] = await pg<{ status: string }[]>`
      select status from distill_state where openclaw_id = ${openclawId}
    `;
    lastStatus = row?.status ?? 'missing';
    if (lastStatus === 'done') return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`distillation did not finish, last status: ${lastStatus}`);
}

async function waitForMemoryContains(file: string, needle: string): Promise<void> {
  let last = '';
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      last = await readFile(file, 'utf8');
      if (last.includes(needle)) return;
    } catch {
      last = '';
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`memory file did not contain ${needle}; latest: ${last.slice(0, 200)}`);
}

describe('memory distillation', () => {
  it('distills migrated transcript rows into collective and per-user memory files', async () => {
    const marker = makeMarker('memory_distill');
    const workspace = await tempWorkspace(marker);
    try {
      const ownerId = await insertUserAccount(`${marker}_gene`);
      const otherUserId = await insertUserAccount(`${marker}_maya`);
      const agentId = await insertAgentAccount(`${marker}_agent`, {
        ownerId,
        openclawId: `${marker}_agent`,
        workspacePath: workspace,
        provisionStatus: 'ready',
        name: 'Memory Probe',
        persona: 'Remembers creative collaborations without leaking private user notes.',
      });
      await insertSessionWithMessages({
        ownerId,
        agentId,
        title: 'Cobalt lighthouse planning',
        messages: [
          {
            senderId: ownerId,
            role: 'user',
            content: 'Private user preference: cobalt lighthouse should stay in my user file.',
            createdAt: new Date('2026-01-01T00:00:00Z'),
          },
          {
            senderId: agentId,
            role: 'assistant',
            content: 'I developed the celadon comet mural concept for the Eden archive.',
            createdAt: new Date('2026-01-01T00:00:01Z'),
          },
          {
            senderId: otherUserId,
            role: 'user',
            content: 'Private other-user detail: violet observatory.',
            createdAt: new Date('2026-01-01T00:00:02Z'),
          },
        ],
      });

      const result = await distillAgentMemory({
        agentAccountId: agentId,
        openclawId: `${marker}_agent`,
        username: `${marker}_agent`,
        name: 'Memory Probe',
        persona: 'Remembers creative collaborations without leaking private user notes.',
        workspacePath: workspace,
      });

      expect(result.status).toBe('done');
      expect(result.messagesSampled).toBe(3);
      const memory = await readFile(path.join(workspace, 'MEMORY.md'), 'utf8');
      expect(memory).toContain('celadon comet mural concept');
      expect(memory).not.toContain('cobalt lighthouse should stay in my user file');
      expect(memory).not.toContain('violet observatory');
      const ownerMemory = await readFile(path.join(workspace, 'memory', 'users', `${marker}_gene.md`), 'utf8');
      expect(ownerMemory).toContain('cobalt lighthouse should stay in my user file');
      const otherMemory = await readFile(path.join(workspace, 'memory', 'users', `${marker}_maya.md`), 'utf8');
      expect(otherMemory).toContain('violet observatory');

      const [row] = await pg<{
        status: string;
        agent_account_id: string | null;
        messages_sampled: number;
        model: string | null;
      }[]>`
        select status, agent_account_id, messages_sampled, model
        from distill_state
        where openclaw_id = ${`${marker}_agent`}
      `;
      expect(row).toMatchObject({
        status: 'done',
        agent_account_id: agentId,
        messages_sampled: 3,
        model: MEMORY_DISTILLATION_MODEL,
      });

      const status = await agentMemoryStatus(`${marker}_agent`, workspace);
      expect(status).toMatchObject({ status: 'done', messagesSampled: 3 });
      expect(status?.summary).toContain('celadon comet mural concept');
    } finally {
      await deleteFixturesByMarker(marker);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('marks agents with too little history as skipped without writing stale memory', async () => {
    const marker = makeMarker('memory_skip');
    const workspace = await tempWorkspace(marker);
    try {
      const ownerId = await insertUserAccount(`${marker}_user`);
      const agentId = await insertAgentAccount(`${marker}_agent`, {
        ownerId,
        openclawId: `${marker}_agent`,
        workspacePath: workspace,
        provisionStatus: 'ready',
      });

      const result = await distillAgentMemory({
        agentAccountId: agentId,
        openclawId: `${marker}_agent`,
        username: `${marker}_agent`,
        workspacePath: workspace,
      });

      expect(result).toMatchObject({
        status: 'skipped',
        messagesSampled: 0,
        skippedReason: 'too_little_history',
      });
      const status = await agentMemoryStatus(`${marker}_agent`, workspace);
      expect(status).toMatchObject({ status: 'skipped', messagesSampled: 0, memoryChars: 0 });
    } finally {
      await deleteFixturesByMarker(marker);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('exposes owner-visible memory status on agent profiles', async () => {
    const marker = makeMarker('memory_profile');
    const workspace = await tempWorkspace(marker);
    const provisioner = makeFakeProvisioner();
    const app = await buildServer({
      provisioning: {
        provisioner,
        cronSync: makeFakeCronSync(),
        skillSync: makeFakeSkillSync(),
        toolSync: makeFakeToolSync(),
      },
    });
    try {
      const ownerId = await insertUserAccount(`${marker}_user`);
      const agentId = await insertAgentAccount(`${marker}_agent`, {
        ownerId,
        openclawId: `${marker}_agent`,
        workspacePath: workspace,
        provisionStatus: 'ready',
        public: false,
      });
      await pg`
        insert into distill_state (openclaw_id, agent_account_id, username, status, messages_sampled, memory_chars, model, completed_at)
        values (${`${marker}_agent`}, ${agentId}, ${`${marker}_agent`}, 'done', 7, 123, ${MEMORY_DISTILLATION_MODEL}, now())
      `;
      await app.ready();

      const ownerRes = await app.inject({
        method: 'GET',
        url: `/agents/${marker}_agent`,
        cookies: { eden3_dev_user: ownerId },
      });
      expect(ownerRes.statusCode).toBe(200);
      expect(ownerRes.json()).toMatchObject({
        memory: {
          status: 'done',
          messagesSampled: 7,
          memoryChars: 123,
          model: MEMORY_DISTILLATION_MODEL,
        },
      });

      const strangerId = await insertUserAccount(`${marker}_stranger`);
      const strangerRes = await app.inject({
        method: 'GET',
        url: `/agents/${marker}_agent`,
        cookies: { eden3_dev_user: strangerId },
      });
      expect(strangerRes.statusCode).toBe(404);
    } finally {
      await app.close();
      await deleteFixturesByMarker(marker);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('starts background memory distillation from the owner profile when history is pending', async () => {
    const marker = makeMarker('memory_profile_lazy');
    const workspace = await tempWorkspace(marker);
    const app = await buildServer({
      provisioning: {
        provisioner: makeFakeProvisioner(),
        cronSync: makeFakeCronSync(),
        skillSync: makeFakeSkillSync(),
        toolSync: makeFakeToolSync(),
      },
    });
    try {
      const ownerId = await insertUserAccount(`${marker}_user`);
      const agentId = await insertAgentAccount(`${marker}_agent`, {
        ownerId,
        openclawId: `${marker}_agent`,
        workspacePath: workspace,
        provisionStatus: 'ready',
        public: true,
        name: 'Lazy Memory Probe',
      });
      await insertSessionWithMessages({
        ownerId,
        agentId,
        title: 'Amber citadel design archive',
        messages: [
          {
            senderId: ownerId,
            role: 'user',
            content:
              'Please remember privately that my favorite material for this project is etched amber glass.',
            createdAt: new Date('2026-02-01T00:00:00Z'),
          },
          {
            senderId: agentId,
            role: 'assistant',
            content:
              'I designed the amber citadel archive room with luminous indexed drawers and a central listening table.',
            createdAt: new Date('2026-02-01T00:00:01Z'),
          },
        ],
      });
      await app.ready();

      const res = await app.inject({
        method: 'GET',
        url: `/agents/${marker}_agent`,
        cookies: { eden3_dev_user: ownerId },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ memory: { status: 'pending' } });

      await waitForDistillDone(`${marker}_agent`);
      const status = await agentMemoryStatus(`${marker}_agent`, workspace);
      expect(status).toMatchObject({ status: 'done', messagesSampled: 2 });
      expect(status?.summary).toContain('amber citadel archive room');
    } finally {
      await app.close();
      await deleteFixturesByMarker(marker);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('lets owners inspect, manually steer, and force-rebuild agent memory', async () => {
    const marker = makeMarker('memory_steer');
    const workspace = await tempWorkspace(marker);
    const app = await buildServer({
      provisioning: {
        provisioner: makeFakeProvisioner(),
        cronSync: makeFakeCronSync(),
        skillSync: makeFakeSkillSync(),
        toolSync: makeFakeToolSync(),
      },
    });
    try {
      const ownerId = await insertUserAccount(`${marker}_user`);
      const strangerId = await insertUserAccount(`${marker}_stranger`);
      const agentId = await insertAgentAccount(`${marker}_agent`, {
        ownerId,
        openclawId: `${marker}_agent`,
        workspacePath: workspace,
        provisionStatus: 'ready',
        public: true,
        name: 'Steerable Memory Probe',
      });
      await mkdir(path.join(workspace, 'memory', 'users'), { recursive: true });
      await writeFile(
        path.join(workspace, 'MEMORY.md'),
        '# MEMORY - Steerable Memory Probe\n\n- original collective note\n',
        'utf8',
      );
      await writeFile(
        path.join(workspace, 'memory', 'users', `${marker}_user.md`),
        `# User memory - ${marker}_user\n\n- private owner note\n`,
        'utf8',
      );
      await pg`
        insert into distill_state (openclaw_id, agent_account_id, username, status, messages_sampled, memory_chars, model, completed_at)
        values (${`${marker}_agent`}, ${agentId}, ${`${marker}_agent`}, 'done', 1, 58, ${MEMORY_DISTILLATION_MODEL}, now())
      `;
      await insertSessionWithMessages({
        ownerId,
        agentId,
        title: 'Silver atlas room',
        messages: [
          {
            senderId: ownerId,
            role: 'user',
            content:
              'Private operator preference: keep the silver atlas notes scoped to my user memory only.',
            createdAt: new Date('2026-03-01T00:00:00Z'),
          },
          {
            senderId: agentId,
            role: 'assistant',
            content:
              'I designed the silver atlas chamber with a ring of mirrored terminals, long-form memory drawers, and a quiet operator table for reviewing agent history.',
            createdAt: new Date('2026-03-01T00:00:01Z'),
          },
        ],
      });
      await app.ready();

      const ownerView = await app.inject({
        method: 'GET',
        url: `/agents/${marker}_agent/memory`,
        cookies: { eden3_dev_user: ownerId },
      });
      expect(ownerView.statusCode).toBe(200);
      expect(ownerView.json()).toMatchObject({
        memory: {
          status: 'done',
          collective: { filename: 'MEMORY.md' },
          userFiles: [expect.objectContaining({ filename: `${marker}_user.md` })],
        },
      });
      expect(ownerView.json().memory.collective.content).toContain('original collective note');

      const strangerView = await app.inject({
        method: 'GET',
        url: `/agents/${marker}_agent/memory`,
        cookies: { eden3_dev_user: strangerId },
      });
      expect(strangerView.statusCode).toBe(403);

      const edited = '# MEMORY - Steerable Memory Probe\n\n- corrected owner-steered note\n';
      const saveRes = await app.inject({
        method: 'PUT',
        url: `/agents/${marker}_agent/memory`,
        cookies: { eden3_dev_user: ownerId },
        payload: { memory: edited },
      });
      expect(saveRes.statusCode).toBe(200);
      expect(saveRes.json()).toMatchObject({
        memory: {
          status: 'done',
          model: MANUAL_MEMORY_MODEL,
          collective: { content: edited },
        },
      });
      expect(await readFile(path.join(workspace, 'MEMORY.md'), 'utf8')).toBe(edited);

      const rebuild = await app.inject({
        method: 'POST',
        url: `/agents/${marker}_agent/memory/rebuild`,
        cookies: { eden3_dev_user: ownerId },
      });
      expect(rebuild.statusCode).toBe(202);
      expect(rebuild.json()).toMatchObject({ queued: true });
      await waitForMemoryContains(path.join(workspace, 'MEMORY.md'), 'silver atlas chamber');
      const rebuilt = await agentMemoryStatus(`${marker}_agent`, workspace);
      expect(rebuilt).toMatchObject({
        status: 'done',
        model: MEMORY_DISTILLATION_MODEL,
        messagesSampled: 2,
      });
    } finally {
      await app.close();
      await deleteFixturesByMarker(marker);
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
