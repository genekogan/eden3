import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DevAuthProvider } from '@eden3/core';
import { loadRootEnv, pg } from '@eden3/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildServer } from '../src/server';
import { reconcileAgentRuntime } from '../src/services/agent-runtime-sync';
import { replaceAgentSkills } from '../src/services/agent-skills';
import {
  deleteFixturesByMarker,
  devCookie,
  insertAgentAccount,
  insertUserAccount,
  makeFakeProvisioner,
  makeFakeSkillSync,
  makeFakeToolSync,
  makeMarker,
} from './fixtures';

loadRootEnv();

const marker = makeMarker('skills');
let ownerId = '';
let strangerId = '';
let adminId = '';
let agentId = '';
let dataDir = '';
let workspaceDir = '';
let app: FastifyInstance;
const skillSync = makeFakeSkillSync();
const provisioner = makeFakeProvisioner();
const toolSync = makeFakeToolSync();
const previousOpenClawDataDir = process.env.OPENCLAW_DATA_DIR;

interface SkillDto {
  id: string;
  slug: string;
  status: string;
  source: string;
}

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `${marker}-data-`));
  process.env.OPENCLAW_DATA_DIR = dataDir;
  workspaceDir = path.join(dataDir, `workspace-${marker}_agent`);
  await fs.mkdir(workspaceDir, { recursive: true });
  ownerId = await insertUserAccount(`${marker}_owner`);
  strangerId = await insertUserAccount(`${marker}_stranger`);
  adminId = await insertUserAccount(`${marker}_admin`);
  agentId = await insertAgentAccount(`${marker}_agent`, {
    ownerId,
    public: true,
    openclawId: `${marker}_agent`,
    workspacePath: workspaceDir,
    provisionStatus: 'ready',
    provisionedAt: new Date(),
  });
  app = await buildServer({
    gateway: null,
    auth: { provider: new DevAuthProvider({ adminUsernames: [`${marker}_admin`] }) },
    provisioning: { provisioner, skillSync, toolSync },
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await fs.rm(dataDir, { recursive: true, force: true });
  if (previousOpenClawDataDir === undefined) delete process.env.OPENCLAW_DATA_DIR;
  else process.env.OPENCLAW_DATA_DIR = previousOpenClawDataDir;
  await deleteFixturesByMarker(marker);
  await pg.end({ timeout: 5 });
});

describe('skills routes', () => {
  it('requires admin review before a user skill can be attached to an agent', async () => {
    const slug = `${marker}_visual`;
    const create = await app.inject({
      method: 'POST',
      url: '/skills/user',
      headers: { cookie: devCookie(ownerId) },
      payload: {
        slug,
        name: 'Visual Critic',
        description: 'Review visual direction before generation.',
        body: '# Visual Critic\n\nAlways critique composition, materials, and lighting before acting.',
      },
    });
    expect(create.statusCode).toBe(201);
    const skill = (create.json() as { skill: SkillDto }).skill;
    expect(skill).toMatchObject({ slug, source: 'user', status: 'pending' });

    const forbidden = await app.inject({
      method: 'POST',
      url: `/agents/${marker}_agent/skills`,
      headers: { cookie: devCookie(ownerId) },
      payload: { slugs: [slug] },
    });
    expect(forbidden.statusCode).toBe(409);
    expect(forbidden.json()).toMatchObject({ error: { code: 'skill_not_approved' } });

    const reviewByStranger = await app.inject({
      method: 'POST',
      url: `/skills/${slug}/review`,
      headers: { cookie: devCookie(strangerId) },
      payload: { status: 'approved' },
    });
    expect(reviewByStranger.statusCode).toBe(403);

    const review = await app.inject({
      method: 'POST',
      url: `/skills/${slug}/review`,
      headers: { cookie: devCookie(adminId) },
      payload: { status: 'approved' },
    });
    expect(review.statusCode).toBe(200);
    expect((review.json() as { skill: SkillDto }).skill.status).toBe('approved');

    const attach = await app.inject({
      method: 'POST',
      url: `/agents/${marker}_agent/skills`,
      headers: { cookie: devCookie(ownerId) },
      payload: { slugs: [slug] },
    });
    expect(attach.statusCode).toBe(200);
    expect(skillSync.calls.at(-1)).toEqual({
      openclawId: `${marker}_agent`,
      skills: [slug],
    });

    const skillFile = await fs.readFile(path.join(workspaceDir, 'skills', slug, 'SKILL.md'), 'utf8');
    expect(skillFile).toContain(`name: ${slug}`);
    expect(skillFile).toContain('description: "Review visual direction before generation."');
    expect(skillFile).toContain('Always critique composition');
    const toolsFile = await fs.readFile(path.join(workspaceDir, 'TOOLS.md'), 'utf8');
    expect(toolsFile).toContain('## Enabled Eden Skills');
    expect(toolsFile).toContain(`Visual Critic (${slug})`);
    expect(toolsFile).toContain('Always critique composition');

    const attached = await app.inject({
      method: 'GET',
      url: `/agents/${marker}_agent/skills`,
      headers: { cookie: devCookie(ownerId) },
    });
    expect(attached.statusCode).toBe(200);
    expect((attached.json() as { attached: SkillDto[] }).attached.map((item) => item.slug)).toEqual([
      slug,
    ]);
  });

  it('replaces the final agent allowlist and removes disallowed skills from sync', async () => {
    const allowed = `${marker}_allowed`;
    const disallowed = `${marker}_disallowed`;
    await pg`
      insert into skill_definitions (slug, name, description, body, source, status)
      values
        (${allowed}, 'Allowed Skill', null, '# Allowed\n\nUse the allowed path.', 'curated', 'approved'),
        (${disallowed}, 'Disallowed Skill', null, '# Disallowed\n\nThis should be removed.', 'curated', 'approved')
    `;

    const both = await app.inject({
      method: 'POST',
      url: `/agents/${marker}_agent/skills`,
      headers: { cookie: devCookie(ownerId) },
      payload: { slugs: [disallowed, allowed] },
    });
    expect(both.statusCode).toBe(200);
    expect(skillSync.calls.at(-1)).toEqual({
      openclawId: `${marker}_agent`,
      skills: [allowed, disallowed],
    });
    const pendingCollision = `${marker}_owner_workspace_only`;
    const ownerSkillDir = path.join(workspaceDir, 'skills', pendingCollision);
    await fs.mkdir(ownerSkillDir, { recursive: true });
    await fs.writeFile(path.join(ownerSkillDir, 'SKILL.md'), '# Owner workspace only\n', 'utf8');
    const pending = await app.inject({
      method: 'POST',
      url: '/skills/user',
      headers: { cookie: devCookie(strangerId) },
      payload: {
        slug: pendingCollision,
        name: 'Foreign pending collision',
        body: '# Pending collision\n\nThis must not claim another agent workspace directory.',
      },
    });
    expect(pending.statusCode).toBe(201);

    const onlyAllowed = await app.inject({
      method: 'POST',
      url: `/agents/${marker}_agent/skills`,
      headers: { cookie: devCookie(ownerId) },
      payload: { slugs: [allowed] },
    });
    expect(onlyAllowed.statusCode).toBe(200);
    expect(skillSync.calls.at(-1)).toEqual({
      openclawId: `${marker}_agent`,
      skills: [allowed],
    });

    const rows = await pg<{ slug: string }[]>`
      select sd.slug
      from agent_skills aks
      join skill_definitions sd on sd.id = aks.skill_id
      where aks.agent_id = ${agentId}
      order by sd.slug asc
    `;
    expect(rows.map((row) => row.slug)).toEqual([allowed]);

    const toolsFile = await fs.readFile(path.join(workspaceDir, 'TOOLS.md'), 'utf8');
    expect(toolsFile).toContain(`Allowed Skill (${allowed})`);
    expect(toolsFile).toContain('Use the allowed path.');
    expect(toolsFile).not.toContain(disallowed);
    expect(toolsFile).not.toContain('This should be removed.');
    await expect(fs.access(path.join(workspaceDir, 'skills', disallowed))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.readFile(path.join(ownerSkillDir, 'SKILL.md'), 'utf8')).resolves.toBe(
      '# Owner workspace only\n',
    );
  });

  it('rejects noncanonical and duplicate selections before durable mutation', async () => {
    const [beforeAgent] = await pg<{
      runtime_sync_version: number;
      runtime_synced_version: number;
    }[]>`
      select runtime_sync_version, runtime_synced_version
      from agents where account_id = ${agentId}
    `;
    const beforeAttached = await pg<{ slug: string; enabled: boolean }[]>`
      select sd.slug, aks.enabled
      from agent_skills aks
      join skill_definitions sd on sd.id = aks.skill_id
      where aks.agent_id = ${agentId}
      order by sd.slug
    `;

    for (const slugs of [
      [`${marker}_allowed`, `${marker}_ALLOWED`],
      [`${marker}_allowed`, ` ${marker}_allowed`],
      [`${marker}_allowed`, `${marker}_allowed`],
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: `/agents/${marker}_agent/skills`,
        headers: { cookie: devCookie(ownerId) },
        payload: { slugs },
      });
      expect(response.statusCode).toBe(400);
    }

    const [afterAgent] = await pg<{
      runtime_sync_version: number;
      runtime_synced_version: number;
    }[]>`
      select runtime_sync_version, runtime_synced_version
      from agents where account_id = ${agentId}
    `;
    const afterAttached = await pg<{ slug: string; enabled: boolean }[]>`
      select sd.slug, aks.enabled
      from agent_skills aks
      join skill_definitions sd on sd.id = aks.skill_id
      where aks.agent_id = ${agentId}
      order by sd.slug
    `;
    expect(afterAgent).toEqual(beforeAgent);
    expect(afterAttached).toEqual(beforeAttached);
  });

  it('rejecting an attached skill clears it from the agent and resyncs OpenClaw', async () => {
    const slug = `${marker}_reject_me`;
    await pg`
      insert into skill_definitions (slug, name, description, body, source, status)
      values (${slug}, 'Reject Me', null, '# Reject Me\n\nTemporary approved skill.', 'user', 'approved')
    `;
    const install = await app.inject({
      method: 'POST',
      url: `/agents/${marker}_agent/skills`,
      headers: { cookie: devCookie(ownerId) },
      payload: { slugs: [slug] },
    });
    expect(install.statusCode).toBe(200);

    const reject = await app.inject({
      method: 'POST',
      url: `/skills/${slug}/review`,
      headers: { cookie: devCookie(adminId) },
      payload: { status: 'rejected' },
    });
    expect(reject.statusCode).toBe(200);
    expect(skillSync.calls.at(-1)).toEqual({
      openclawId: `${marker}_agent`,
      skills: [],
    });

    const rows = await pg<{ count: number; enabled_count: number }[]>`
      select count(*)::int as count,
             count(*) filter (where aks.enabled)::int as enabled_count
      from agent_skills aks
      join skill_definitions sd on sd.id = aks.skill_id
      where sd.slug = ${slug}
    `;
    expect(rows[0]).toEqual({ count: 1, enabled_count: 0 });
    await expect(fs.access(path.join(workspaceDir, 'skills', slug))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const toolsFile = await fs.readFile(path.join(workspaceDir, 'TOOLS.md'), 'utf8');
    expect(toolsFile).not.toContain(slug);
    expect(toolsFile).not.toContain('Temporary approved skill.');
  });

  it('keeps a committed skill selection pending when projection fails, then retries it', async () => {
    const slug = `${marker}_retry_projection`;
    await pg`
      insert into skill_definitions (slug, name, description, body, source, status)
      values (
        ${slug}, 'Retry Projection', null,
        '# Retry Projection\n\nThis desired skill must survive a runtime outage.',
        'curated', 'approved'
      )
    `;

    const originalSync = skillSync.syncAgentSkills;
    let failOnce = true;
    skillSync.syncAgentSkills = async (params) => {
      skillSync.calls.push(params);
      if (failOnce) {
        failOnce = false;
        throw new Error('simulated manifest write outage');
      }
      return { changed: true };
    };
    try {
      const saved = await app.inject({
        method: 'POST',
        url: `/agents/${marker}_agent/skills`,
        headers: { cookie: devCookie(ownerId) },
        payload: { slugs: [slug] },
      });
      expect(saved.statusCode).toBe(202);
      expect(saved.json()).toMatchObject({ runtimeSync: 'pending' });

      const [pending] = await pg<{
        runtime_sync_version: number;
        runtime_synced_version: number;
        runtime_sync_error: string | null;
      }[]>`
        select runtime_sync_version, runtime_synced_version, runtime_sync_error
        from agents where account_id = ${agentId}
      `;
      expect(pending!.runtime_sync_version).toBeGreaterThan(pending!.runtime_synced_version);
      expect(pending!.runtime_sync_error).toContain('retry pending');
      const desired = await pg<{ slug: string }[]>`
        select sd.slug
        from agent_skills aks
        join skill_definitions sd on sd.id = aks.skill_id
        where aks.agent_id = ${agentId}
      `;
      expect(desired.map((row) => row.slug)).toEqual([slug]);

      // Simulate the durable retry backoff expiring. The same DB selection is
      // projected without another owner mutation.
      await pg`
        update agents set runtime_sync_lease_expires_at = null
        where account_id = ${agentId}
      `;
      await expect(
        reconcileAgentRuntime(agentId, {
          provisioner,
          toolSync,
          skillSync,
          dataDir,
        }),
      ).resolves.toMatchObject({ status: 'synced' });
      const [recovered] = await pg<{
        runtime_sync_version: number;
        runtime_synced_version: number;
        runtime_sync_error: string | null;
      }[]>`
        select runtime_sync_version, runtime_synced_version, runtime_sync_error
        from agents where account_id = ${agentId}
      `;
      expect(recovered).toMatchObject({ runtime_sync_error: null });
      expect(recovered!.runtime_synced_version).toBe(recovered!.runtime_sync_version);
      expect(skillSync.calls.at(-1)).toEqual({
        openclawId: `${marker}_agent`,
        skills: [slug],
      });
    } finally {
      skillSync.syncAgentSkills = originalSync;
    }
  });

  it('keeps an admin rejection durable when its immediate runtime projection fails', async () => {
    const slug = `${marker}_rejection_retry`;
    await pg`
      insert into skill_definitions (slug, name, description, body, source, status)
      values (
        ${slug}, 'Rejection Retry', null,
        '# Rejection Retry\n\nThis skill will be rejected during a runtime outage.',
        'user', 'approved'
      )
    `;
    const installed = await app.inject({
      method: 'POST',
      url: `/agents/${marker}_agent/skills`,
      headers: { cookie: devCookie(ownerId) },
      payload: { slugs: [slug] },
    });
    expect(installed.statusCode).toBe(200);

    const originalSync = skillSync.syncAgentSkills;
    let failOnce = true;
    skillSync.syncAgentSkills = async (params) => {
      skillSync.calls.push(params);
      if (failOnce) {
        failOnce = false;
        throw new Error('simulated rejection projection outage');
      }
      return { changed: true };
    };
    try {
      const rejected = await app.inject({
        method: 'POST',
        url: `/skills/${slug}/review`,
        headers: { cookie: devCookie(adminId) },
        payload: { status: 'rejected' },
      });
      expect(rejected.statusCode).toBe(200);
      const [pending] = await pg<{
        runtime_sync_version: number;
        runtime_synced_version: number;
        runtime_sync_error: string | null;
      }[]>`
        select runtime_sync_version, runtime_synced_version, runtime_sync_error
        from agents where account_id = ${agentId}
      `;
      expect(pending!.runtime_sync_version).toBeGreaterThan(pending!.runtime_synced_version);
      expect(pending!.runtime_sync_error).toContain('retry pending');
      const [attachment] = await pg<{ count: number; enabled_count: number }[]>`
        select count(*)::int as count,
               count(*) filter (where aks.enabled)::int as enabled_count
        from agent_skills aks
        join skill_definitions sd on sd.id = aks.skill_id
        where aks.agent_id = ${agentId} and sd.slug = ${slug}
      `;
      expect(attachment).toEqual({ count: 1, enabled_count: 0 });
      // Filesystem cleanup precedes the fallible OpenClaw allowlist sync. A
      // rejected instruction is unavailable even while the durable runtime
      // revision truthfully remains pending for retry.
      await expect(fs.access(path.join(workspaceDir, 'skills', slug))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      const pendingTools = await fs.readFile(path.join(workspaceDir, 'TOOLS.md'), 'utf8');
      expect(pendingTools).not.toContain(slug);
      expect(pendingTools).not.toContain('This skill will be rejected during a runtime outage.');

      await pg`
        update agents set runtime_sync_lease_expires_at = null
        where account_id = ${agentId}
      `;
      await expect(
        reconcileAgentRuntime(agentId, {
          provisioner,
          toolSync,
          skillSync,
          dataDir,
        }),
      ).resolves.toMatchObject({ status: 'synced' });
      expect(skillSync.calls.at(-1)).toEqual({
        openclawId: `${marker}_agent`,
        skills: [],
      });
    } finally {
      skillSync.syncAgentSkills = originalSync;
    }
  });

  it('serializes direct first-provision projection with concurrent rejection cleanup', async () => {
    const slug = `${marker}_direct_rejection`;
    await pg`
      insert into skill_definitions (slug, name, description, body, source, status)
      values (
        ${slug}, 'Direct Rejection', null,
        '# Direct Rejection\n\nA concurrent rejection must win after projection.',
        'user', 'approved'
      )
    `;
    let entered!: () => void;
    let release!: () => void;
    const enteredSync = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releaseSync = new Promise<void>((resolve) => {
      release = resolve;
    });
    const directSync = {
      async syncAgentSkills() {
        entered();
        await releaseSync;
        return { changed: true };
      },
    };

    const projection = replaceAgentSkills({
      agentId,
      openclawId: `${marker}_agent`,
      workspacePath: workspaceDir,
      slugs: [slug],
      skillSync: directSync,
    });
    await enteredSync;
    let rejectionSettled = false;
    const rejection = app
      .inject({
        method: 'POST',
        url: `/skills/${slug}/review`,
        headers: { cookie: devCookie(adminId) },
        payload: { status: 'rejected' },
      })
      .finally(() => {
        rejectionSettled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(rejectionSettled).toBe(false);

    release();
    await expect(projection).resolves.toMatchObject({ openclaw: { changed: true } });
    const rejected = await rejection;
    expect(rejected.statusCode).toBe(200);
    await expect(fs.access(path.join(workspaceDir, 'skills', slug))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const [attachment] = await pg<{ status: string; enabled: boolean }[]>`
      select sd.status, aks.enabled
      from agent_skills aks
      join skill_definitions sd on sd.id = aks.skill_id
      where aks.agent_id = ${agentId} and sd.slug = ${slug}
    `;
    expect(attachment).toEqual({ status: 'rejected', enabled: false });
    expect(skillSync.calls.at(-1)).toEqual({
      openclawId: `${marker}_agent`,
      skills: [],
    });
  });

  it('serializes concurrent skill projections so an older runtime write cannot win', async () => {
    const firstSlug = `${marker}_concurrent_a`;
    const winnerSlug = `${marker}_concurrent_b`;
    await pg`
      insert into skill_definitions (slug, name, description, body, source, status)
      values
        (${firstSlug}, 'Concurrent A', null, '# A\n\nOlder desired state.', 'curated', 'approved'),
        (${winnerSlug}, 'Concurrent B', null, '# B\n\nNewest desired state.', 'curated', 'approved')
    `;

    const originalSync = skillSync.syncAgentSkills;
    let releaseFirst!: () => void;
    let enteredFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    let blocked = false;
    skillSync.syncAgentSkills = async (params) => {
      skillSync.calls.push(params);
      if (!blocked && params.skills.length === 1 && params.skills[0] === firstSlug) {
        blocked = true;
        enteredFirst();
        await firstGate;
      }
      return { changed: true };
    };
    try {
      const first = app.inject({
        method: 'POST',
        url: `/agents/${marker}_agent/skills`,
        headers: { cookie: devCookie(ownerId) },
        payload: { slugs: [firstSlug] },
      });
      await firstEntered;

      const second = app.inject({
        method: 'POST',
        url: `/agents/${marker}_agent/skills`,
        headers: { cookie: devCookie(ownerId) },
        payload: { slugs: [winnerSlug] },
      });
      await vi.waitFor(async () => {
        const desired = await pg<{ slug: string }[]>`
          select sd.slug
          from agent_skills aks
          join skill_definitions sd on sd.id = aks.skill_id
          where aks.agent_id = ${agentId}
        `;
        expect(desired.map((row) => row.slug)).toEqual([winnerSlug]);
      });
      // The second request has committed its DB revision, but its runtime
      // projection cannot pass the first claimant's session advisory lock.
      expect(skillSync.calls.at(-1)).toEqual({
        openclawId: `${marker}_agent`,
        skills: [firstSlug],
      });

      releaseFirst();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult.statusCode).toBe(200);
      expect(secondResult.statusCode).toBe(200);
      expect(skillSync.calls.at(-1)).toEqual({
        openclawId: `${marker}_agent`,
        skills: [winnerSlug],
      });
      const [runtime] = await pg<{
        runtime_sync_version: number;
        runtime_synced_version: number;
      }[]>`
        select runtime_sync_version, runtime_synced_version
        from agents where account_id = ${agentId}
      `;
      expect(runtime!.runtime_synced_version).toBe(runtime!.runtime_sync_version);
      const toolsFile = await fs.readFile(path.join(workspaceDir, 'TOOLS.md'), 'utf8');
      expect(toolsFile).toContain(`Concurrent B (${winnerSlug})`);
      expect(toolsFile).not.toContain(`Concurrent A (${firstSlug})`);
    } finally {
      releaseFirst();
      skillSync.syncAgentSkills = originalSync;
    }
  });

  it('blocks non-owners from changing an agent skill allowlist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/agents/${marker}_agent/skills`,
      headers: { cookie: devCookie(strangerId) },
      payload: { slugs: [] },
    });
    expect(res.statusCode).toBe(403);
  });

  it('retires eden-safe-base: not in the catalog, not a default, not attachable', async () => {
    // Privacy/safety moved to the platform layer (AGENTS.md conduct + the egress
    // sealed-interior + capability floor). ensureBuiltinSkills (run at boot)
    // deletes the row, so it must be absent from every skill surface.
    const [defCount] = await pg<{ count: number }[]>`
      select count(*)::int as count from skill_definitions where slug = 'eden-safe-base'
    `;
    expect(defCount!.count).toBe(0);

    const catalog = await app.inject({ method: 'GET', url: '/skills' });
    expect(catalog.statusCode).toBe(200);
    const slugs = (catalog.json() as { items: SkillDto[] }).items.map((item) => item.slug);
    expect(slugs).not.toContain('eden-safe-base');

    // It is no longer an installable skill.
    const attach = await app.inject({
      method: 'POST',
      url: `/agents/${marker}_agent/skills`,
      headers: { cookie: devCookie(ownerId) },
      payload: { slugs: ['eden-safe-base'] },
    });
    expect(attach.statusCode).toBe(404);
    expect(attach.json()).toMatchObject({ error: { code: 'skill_not_found' } });
  });
});
