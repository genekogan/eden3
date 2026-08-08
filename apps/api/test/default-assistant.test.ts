import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DevAuthProvider } from '@eden3/core';
import { loadRootEnv, pg } from '@eden3/db';
import type { AgentDto } from '@eden3/shared';
import type { FastifyInstance, InjectOptions } from 'fastify';
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

type RouteMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';
interface EveRouteInventoryItem {
  method: RouteMethod;
  path: string;
  source: string;
}

function declaredRoutes(source: string, prefix: string): EveRouteInventoryItem[] {
  const filename = fileURLToPath(new URL(`../src/routes/${source}.ts`, import.meta.url));
  const code = readFileSync(filename, 'utf8');
  const routes: EveRouteInventoryItem[] = [];
  const matcher = /app\.(get|put|post|patch|delete)\(\s*['"]([^'"]+)['"]/g;
  for (const match of code.matchAll(matcher)) {
    routes.push({
      method: match[1]!.toUpperCase() as RouteMethod,
      path: match[2] === '/' ? prefix : `${prefix}${match[2]}`,
      source,
    });
  }
  return routes;
}

/**
 * Narrow defender inventory: route declarations that can inspect or change
 * Eve's configuration/runtime state. Social/chat reads are intentionally not
 * swept into this T25-U01/U02 verification slice.
 */
function eveRouteInventory(): EveRouteInventoryItem[] {
  const agentRoutes = declaredRoutes('agents', '/agents').filter(
    (route) =>
      (route.method === 'PATCH' && route.path === '/agents/:username') ||
      /^\/agents\/:username\/(?:memory(?:\/|$)|repair$|activity$|export$|avatar$)/.test(
        route.path,
      ),
  );
  const conceptRoutes = declaredRoutes('concepts', '/agents').filter((route) =>
    route.path.startsWith('/agents/:username/concepts'),
  );
  const workspaceRoutes = declaredRoutes('workspace', '/agents').filter((route) =>
    route.path.startsWith('/agents/:username/workspace'),
  );
  const skillRoutes = declaredRoutes('skills', '').filter(
    (route) => route.path === '/agents/:username/skills',
  );
  const taskRoutes = declaredRoutes('triggers', '/tasks').filter(
    (route) => route.method !== 'GET',
  );
  return [
    ...agentRoutes,
    ...conceptRoutes,
    ...workspaceRoutes,
    ...skillRoutes,
    ...taskRoutes,
  ].sort((left, right) =>
    `${left.method} ${left.path}`.localeCompare(`${right.method} ${right.path}`),
  );
}

function routeKey(route: EveRouteInventoryItem): string {
  return `${route.method} ${route.path}`;
}

const SAFE_READ_ROUTES = new Set([
  'GET /agents/:username/concepts',
  'GET /agents/:username/skills',
]);

function protectedRouteRequest(
  route: EveRouteInventoryItem,
  cookie: string,
  taskId: string,
): InjectOptions {
  const objectId = '00000000-0000-4000-8000-000000000001';
  let url = route.path
    .replace(':username', DEFAULT_EVE_USERNAME)
    .replace(':imageId', objectId)
    .replace(':slug', 'missing')
    .replace(':id', taskId);
  let payload: Record<string, unknown> | undefined;
  switch (routeKey(route)) {
    case 'PUT /agents/:username/memory':
      payload = { memory: 'must not write' };
      break;
    case 'POST /agents/:username/memory/rebuild':
      payload = { confirm: 'reseed' };
      break;
    case 'POST /agents/:username/memory/search-probe':
      payload = { query: 'verification query', maxResults: 1 };
      break;
    case 'PATCH /agents/:username':
      payload = { name: 'Not Eve' };
      break;
    case 'POST /agents/:username/avatar':
      payload = { mime: 'image/png', dataBase64: 'AAAA' };
      break;
    case 'PUT /agents/:username/workspace/file':
      payload = { path: 'SOUL.md', content: 'must not write', baseSha256: 'new' };
      break;
    case 'POST /agents/:username/skills':
      payload = { slugs: [] };
      break;
    case 'POST /agents/:username/concepts':
      payload = { name: 'Must not exist' };
      break;
    case 'PATCH /agents/:username/concepts/:slug':
      payload = { name: 'Must not change' };
      break;
    case 'POST /agents/:username/concepts/:slug/images':
      payload = { mime: 'image/png', dataBase64: 'AAAA' };
      break;
    case 'PATCH /agents/:username/concepts/:slug/images':
      payload = { imageIds: [objectId] };
      break;
    case 'POST /tasks':
      payload = {
        agentUsername: DEFAULT_EVE_USERNAME,
        name: 'Must not schedule',
        prompt: 'This must never run',
        schedule: { at: '2099-01-01T00:00:00.000Z' },
      };
      break;
    case 'PATCH /tasks/:id':
      payload = { name: 'Must not change' };
      break;
  }
  if (route.path.includes('/workspace/file')) {
    url += `${url.includes('?') ? '&' : '?'}path=memory/users/other.md`;
  } else if (route.path.endsWith('/workspace/download')) {
    url += '?path=memory/users/other.md';
  }
  return {
    method: route.method,
    url,
    headers: { cookie },
    ...(payload === undefined ? {} : { payload }),
  };
}

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

    const rows = await pg<
      {
        accountId: string;
        username: string;
        openclawId: string | null;
        status: string;
        public: boolean;
        ownerId: string | null;
      }[]
    >`
      select a.id as "accountId", a.username::text as username,
             g.openclaw_id as "openclawId",
             g.provision_status as status, g.public, g.owner_id as "ownerId"
      from accounts a
      join agents g on g.account_id = a.id
      where a.username = ${DEFAULT_EVE_USERNAME}
         or g.openclaw_id = ${DEFAULT_EVE_OPENCLAW_ID}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.accountId).toBe(results[0]!.accountId);
    expect(rows[0]).toMatchObject({
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
    expect((body as { memory?: unknown }).memory).toBeNull();
  });

  it('reserves Eve and main across direct provision and import handles', async () => {
    const cookie = devCookie(adminId);
    const bundle = (username: string) => ({
      kind: 'eden3.agent.bundle',
      version: 1,
      agent: { username, name: 'Reserved copy' },
      memory: { items: [] },
      skills: [],
    });
    const attempts = [DEFAULT_EVE_USERNAME, DEFAULT_EVE_OPENCLAW_ID].flatMap((username) => [
      app.inject({
        method: 'POST',
        url: '/agents',
        headers: { cookie },
        payload: { username, name: 'Reserved copy' },
      }),
      app.inject({
        method: 'POST',
        url: '/agents/import',
        headers: { cookie },
        payload: { username, bundle: bundle(username) },
      }),
    ]);
    const responses = await Promise.all(attempts);
    expect(responses.map((response) => response.statusCode)).toEqual([400, 400, 400, 400]);
    const [identityCount] = await pg<{ count: number }[]>`
      select count(*)::int as count
      from accounts a
      left join agents g on g.account_id = a.id
      where a.username in (${DEFAULT_EVE_USERNAME}, ${DEFAULT_EVE_OPENCLAW_ID})
         or g.openclaw_id = ${DEFAULT_EVE_OPENCLAW_ID}
    `;
    expect(identityCount?.count).toBe(1);
  });

  it('denies every inventoried configuration alias to an administrator without raw memory', async () => {
    const inventory = eveRouteInventory();
    expect(inventory.map(routeKey)).toEqual([
      'DELETE /agents/:username/avatar',
      'DELETE /agents/:username/concepts/:slug',
      'DELETE /agents/:username/concepts/:slug/images/:imageId',
      'GET /agents/:username/activity',
      'GET /agents/:username/concepts',
      'GET /agents/:username/export',
      'GET /agents/:username/memory',
      'GET /agents/:username/skills',
      'GET /agents/:username/workspace',
      'GET /agents/:username/workspace/download',
      'GET /agents/:username/workspace/export',
      'GET /agents/:username/workspace/file',
      'PATCH /agents/:username',
      'PATCH /agents/:username/concepts/:slug',
      'PATCH /agents/:username/concepts/:slug/images',
      'PATCH /tasks/:id',
      'POST /agents/:username/avatar',
      'POST /agents/:username/concepts',
      'POST /agents/:username/concepts/:slug/images',
      'POST /agents/:username/memory/rebuild',
      'POST /agents/:username/memory/search-probe',
      'POST /agents/:username/repair',
      'POST /agents/:username/skills',
      'POST /tasks',
      'POST /tasks/:id/runs',
      'PUT /agents/:username/memory',
      'PUT /agents/:username/workspace/file',
    ]);

    const [eve] = await pg<{ id: string }[]>`
      select a.id from accounts a
      join agents g on g.account_id = a.id
      where a.username = ${DEFAULT_EVE_USERNAME}
        and g.openclaw_id = ${DEFAULT_EVE_OPENCLAW_ID}
    `;
    expect(eve).toBeDefined();
    const [task] = await pg<{ id: string }[]>`
      insert into triggers (
        user_id, agent_id, name, prompt, schedule, status,
        session_target, next_scheduled_run
      ) values (
        ${adminId}, ${eve!.id}, ${`${marker}_eve_task`}, 'must not run',
        ${JSON.stringify({ at: '2099-01-01T00:00:00.000Z' })}::jsonb,
        'active', 'new', '2099-01-01T00:00:00.000Z'
      )
      returning id
    `;
    const [before] = await pg<
      {
        username: string;
        userImage: string | null;
        name: string | null;
        description: string | null;
        persona: string | null;
        greeting: string | null;
        voice: string | null;
        model: string;
        thinkingLevel: string;
        toolGroups: unknown;
        openclawId: string | null;
        runtimeSyncVersion: number;
      }[]
    >`
      select a.username::text as username, a.user_image as "userImage",
             g.name, g.description, g.persona, g.greeting, g.voice, g.model,
             g.thinking_level as "thinkingLevel", g.tool_groups as "toolGroups",
             g.openclaw_id as "openclawId",
             g.runtime_sync_version as "runtimeSyncVersion"
      from accounts a join agents g on g.account_id = a.id
      where a.id = ${eve!.id}
    `;
    const responses = await Promise.all(
      inventory.map(async (route) => ({
        route,
        response: await app.inject(protectedRouteRequest(route, devCookie(adminId), task!.id)),
      })),
    );
    for (const { route, response } of responses) {
      const key = routeKey(route);
      expect(response.statusCode, key).toBe(SAFE_READ_ROUTES.has(key) ? 200 : 403);
      const body = response.json() as Record<string, unknown>;
      expect(body, key).not.toHaveProperty('memory');
      expect(body, key).not.toHaveProperty('file');
      expect(body, key).not.toHaveProperty('bundle');
      expect(body, key).not.toHaveProperty('probe');
      if (key === 'GET /agents/:username/skills') {
        expect(body).not.toHaveProperty('available');
      }
    }
    const [after] = await pg<typeof before[]>`
      select a.username::text as username, a.user_image as "userImage",
             g.name, g.description, g.persona, g.greeting, g.voice, g.model,
             g.thinking_level as "thinkingLevel", g.tool_groups as "toolGroups",
             g.openclaw_id as "openclawId",
             g.runtime_sync_version as "runtimeSyncVersion"
      from accounts a join agents g on g.account_id = a.id
      where a.id = ${eve!.id}
    `;
    expect(after).toEqual(before);
    const [taskAfter] = await pg<{ name: string; prompt: string; status: string }[]>`
      select name, prompt, status from triggers where id = ${task!.id}
    `;
    expect(taskAfter).toEqual({
      name: `${marker}_eve_task`,
      prompt: 'must not run',
      status: 'active',
    });
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
