import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { assertMatchingDatabaseSelection } from '../../../infra/agent-cron-bridge/server.mjs';
import {
  databaseNameFromApiUrl,
  resolveComposeDatabaseEnv,
} from '../../../scripts/compose.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const read = (relative) => fs.readFile(new URL(relative, `file://${repoRoot}/`), 'utf8');

describe('metered self-cron infrastructure contract', () => {
  it('bakes the optional eden_cron plugin and never delegates to gateway cron', async () => {
    const [dockerfile, plugin, manifest, packageJson, packageLock] = await Promise.all([
      read('infra/openclaw/Dockerfile'),
      read('infra/openclaw/plugins/eden3-cron/index.js'),
      read('infra/openclaw/plugins/eden3-cron/openclaw.plugin.json'),
      read('infra/openclaw/plugins/eden3-cron/package.json'),
      read('infra/openclaw/plugins/eden3-cron/package-lock.json'),
    ]);
    expect(dockerfile).toContain(
      'plugins/eden3-cron /opt/eden3/openclaw-plugins/eden3-cron',
    );
    expect(dockerfile).toContain('npm ci --omit=dev --ignore-scripts');
    expect(JSON.parse(packageJson)).toMatchObject({ dependencies: { typebox: expect.any(String) } });
    expect(JSON.parse(packageLock)).toMatchObject({ lockfileVersion: 3 });
    expect(plugin).toContain("name: 'eden_cron'");
    expect(plugin).toContain('optional: true');
    expect(plugin).toContain('toolContext.sessionKey');
    expect(plugin).not.toMatch(/cron\s+(add|update|enable)/);
    expect(JSON.parse(manifest)).toMatchObject({
      contracts: { tools: ['eden_cron'] },
      toolMetadata: { eden_cron: { optional: true } },
    });
    const configGen = await read('packages/gateway/src/config-gen.ts');
    expect(configGen).toContain("if (!deny.includes('cron')) deny.push('cron')");
  });

  it('keeps DB credentials in a hardened socket sidecar, outside OpenClaw', async () => {
    const compose = await read('infra/docker-compose.yml');
    const bridgeStart = compose.indexOf('  agent-cron-bridge:');
    const openclawStart = compose.indexOf('  openclaw:');
    const volumesStart = compose.indexOf('\nvolumes:');
    expect(bridgeStart).toBeGreaterThan(0);
    const bridge = compose.slice(bridgeStart, openclawStart);
    const openclaw = compose.slice(openclawStart, volumesStart);
    expect(bridge).toContain(
      'DATABASE_URL: "postgres://eden3:eden3@postgres:5432/${EDEN3_DATABASE_NAME:?',
    );
    expect(bridge).toContain('EDEN3_API_DATABASE_URL: "${EDEN3_COMPOSE_API_DATABASE_URL:?');
    expect(bridge).toContain('MAX_SCHEDULED_TASKS_PER_USER: "${MAX_SCHEDULED_TASKS_PER_USER:-100}"');
    expect(bridge).not.toContain('EDEN3_DATABASE_NAME:-eden3');
    expect(bridge).not.toContain('AGENT_CRON_DATABASE_URL');
    expect(bridge).toContain('agent_cron_db');
    expect(bridge).toContain('read_only: true');
    expect(bridge).toContain('no-new-privileges:true');
    expect(openclaw).toContain('agent_cron_socket:/run/eden3-cron:ro');
    expect(openclaw).not.toContain('EDEN3_API_DATABASE_URL');
    expect(openclaw).not.toMatch(/DATABASE_URL:/);
    expect(openclaw).not.toContain('MAX_SCHEDULED_TASKS_PER_USER');

    const envExample = await read('.env.example');
    expect(envExample).toContain('MAX_SCHEDULED_TASKS_PER_USER=100');
  });

  it('refuses to open its socket against a different logical DB than the API', () => {
    expect(
      assertMatchingDatabaseSelection(
        'postgres://sidecar@postgres:5432/eden3',
        'postgres://api@localhost:5433/eden3',
      ),
    ).toBe('eden3');
    expect(() =>
      assertMatchingDatabaseSelection(
        'postgres://sidecar@postgres:5432/eden3_stg',
        'postgres://api@localhost:5433/eden3',
      ),
    ).toThrow(/does not match the API/);
  });

  it('derives the Compose selector from the exact API URL without a canonical fallback', () => {
    const apiUrl = 'postgres://api@localhost:5433/eden3_stg';
    expect(databaseNameFromApiUrl(apiUrl)).toBe('eden3_stg');
    expect(resolveComposeDatabaseEnv({ DATABASE_URL: apiUrl })).toMatchObject({
      EDEN3_DATABASE_NAME: 'eden3_stg',
      EDEN3_COMPOSE_API_DATABASE_URL: apiUrl,
    });
    expect(() =>
      resolveComposeDatabaseEnv({
        DATABASE_URL: apiUrl,
        EDEN3_DATABASE_NAME: 'eden3',
      }),
    ).toThrow(/must match DATABASE_URL database "eden3_stg"/);
    expect(() => databaseNameFromApiUrl('postgres://api@localhost:5433/a/b')).toThrow(
      /one safe logical database name/,
    );
    for (const url of [
      'postgres://api@localhost:5433/scratch/../eden3',
      'postgres://api@localhost:5433/scratch/%2e%2e/eden3',
      'postgres://api@localhost:5433/./eden3',
      'postgres://api@localhost:5433/%65den3',
    ]) {
      expect(() => databaseNameFromApiUrl(url), url).toThrow(/one safe logical database name/);
    }
    expect(() =>
      assertMatchingDatabaseSelection(
        'postgres://sidecar@postgres:5432/scratch/../eden3',
        'postgres://api@localhost:5433/eden3',
      ),
    ).toThrow(/does not match the API/);
  });
});
