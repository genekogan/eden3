import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DevAuthProvider } from '@eden3/core';
import { loadRootEnv, pg } from '@eden3/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from '../src/server';
import {
  deleteFixturesByMarker,
  devCookie,
  insertAgentAccount,
  insertUserAccount,
  makeFakeSkillSync,
  makeMarker,
} from './fixtures';

loadRootEnv();

const marker = makeMarker('skills');
let ownerId = '';
let strangerId = '';
let adminId = '';
let agentId = '';
let workspaceDir = '';
let app: FastifyInstance;
const skillSync = makeFakeSkillSync();

interface SkillDto {
  id: string;
  slug: string;
  status: string;
  source: string;
}

beforeAll(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), `${marker}-workspace-`));
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
    provisioning: { skillSync },
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await fs.rm(workspaceDir, { recursive: true, force: true });
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

    const rows = await pg<{ count: number }[]>`
      select count(*)::int as count
      from agent_skills aks
      join skill_definitions sd on sd.id = aks.skill_id
      where sd.slug = ${slug}
    `;
    expect(rows[0]!.count).toBe(0);
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
});
