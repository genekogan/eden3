import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ConfigGenError,
  SANDBOX_EGRESS_NETWORK,
  SANDBOX_EGRESS_PROXY_URL,
  SANDBOX_NO_PROXY,
  ensureBaseline,
  openclawConfigPath,
  readOpenClawConfig,
  resolveDataDir,
  setAgentModel,
  setAgentSkills,
  setAgentToolGroups,
  writeOpenClawConfig,
} from '../src/config-gen';

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eden3-config-gen-'));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function seedConfig(config: Record<string, unknown>): Promise<void> {
  await fs.writeFile(openclawConfigPath(dataDir), JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
}

describe('resolveDataDir', () => {
  it('prefers OPENCLAW_DATA_DIR and falls back to infra/openclaw/data', () => {
    expect(resolveDataDir({ OPENCLAW_DATA_DIR: '/x/y' })).toBe(path.resolve('/x/y'));
    expect(resolveDataDir({})).toBe(path.resolve('infra', 'openclaw', 'data'));
    expect(resolveDataDir({ OPENCLAW_DATA_DIR: '' })).toBe(path.resolve('infra', 'openclaw', 'data'));
  });
});

describe('read/writeOpenClawConfig', () => {
  it('round-trips and returns {} for a missing file', async () => {
    expect(await readOpenClawConfig(dataDir)).toEqual({});
    await writeOpenClawConfig(dataDir, { a: { b: 1 } });
    expect(await readOpenClawConfig(dataDir)).toEqual({ a: { b: 1 } });
  });

  it('writes atomically: no tmp litter, 0600 mode, trailing newline', async () => {
    await writeOpenClawConfig(dataDir, { x: 1 });
    const entries = await fs.readdir(dataDir);
    expect(entries).toEqual(['openclaw.json']);
    const stat = await fs.stat(openclawConfigPath(dataDir));
    expect(stat.mode & 0o777).toBe(0o600);
    const raw = await fs.readFile(openclawConfigPath(dataDir), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('throws ConfigGenError on malformed or non-object JSON', async () => {
    await fs.writeFile(openclawConfigPath(dataDir), '{nope');
    await expect(readOpenClawConfig(dataDir)).rejects.toBeInstanceOf(ConfigGenError);
    await fs.writeFile(openclawConfigPath(dataDir), '[1,2]');
    await expect(readOpenClawConfig(dataDir)).rejects.toBeInstanceOf(ConfigGenError);
  });
});

describe('ensureBaseline', () => {
  it('bootstraps the gateway baseline into an empty config', async () => {
    const { changed, config } = await ensureBaseline({ dataDir });
    expect(changed).toBe(true);
    expect(config).toEqual({
      gateway: {
        mode: 'local',
        auth: {
          mode: 'token',
          rateLimit: {
            maxAttempts: 10,
            windowMs: 60000,
            lockoutMs: 300000,
            exemptLoopback: false,
          },
        },
        http: {
          endpoints: {
            chatCompletions: { enabled: true },
            responses: { enabled: true },
          },
        },
        controlUi: {
          allowedOrigins: ['http://127.0.0.1:18789', 'http://localhost:18789'],
        },
      },
      agents: {
        defaults: {
          sandbox: {
            mode: 'all',
            scope: 'session',
            workspaceAccess: 'none',
            docker: {
              network: SANDBOX_EGRESS_NETWORK,
              binds: [],
              env: {
                HTTP_PROXY: SANDBOX_EGRESS_PROXY_URL,
                HTTPS_PROXY: SANDBOX_EGRESS_PROXY_URL,
                http_proxy: SANDBOX_EGRESS_PROXY_URL,
                https_proxy: SANDBOX_EGRESS_PROXY_URL,
                NO_PROXY: SANDBOX_NO_PROXY,
                no_proxy: SANDBOX_NO_PROXY,
              },
            },
          },
          imageGenerationModel: {
            primary: 'fal/fal-ai/flux/dev',
            fallbacks: ['google/gemini-3-pro-image-preview'],
          },
          memorySearch: {
            enabled: true,
            provider: 'openai',
          },
        },
      },
      tools: {
        profile: 'coding',
        allow: [
          'group:runtime',
          'group:fs',
          'group:web',
          'group:sessions',
          'group:memory',
          'group:media',
          'tts',
          'group:ui',
          'group:automation',
          'group:agents',
          'group:plugins',
        ],
        sandbox: {
          tools: {
            allow: [
              'group:runtime',
              'group:fs',
              'group:web',
              'group:sessions',
              'group:memory',
              'group:media',
              'tts',
              'group:ui',
              'group:automation',
              'group:agents',
              'group:plugins',
            ],
          },
        },
        exec: {
          host: 'sandbox',
          security: 'full',
          ask: 'off',
          strictInlineEval: true,
        },
        elevated: {
          enabled: false,
        },
      },
    });
    expect(await readOpenClawConfig(dataDir)).toEqual(config);
  });

  it('is idempotent and preserves unrelated keys', async () => {
    await seedConfig({
      gateway: {
        mode: 'local',
        port: 18789,
        auth: {
          mode: 'token',
          rateLimit: {
            maxAttempts: 10,
            windowMs: 60000,
            lockoutMs: 300000,
            exemptLoopback: false,
          },
        },
        controlUi: {
          allowedOrigins: ['http://127.0.0.1:18789', 'http://localhost:18789'],
        },
      },
      agents: {
        defaults: {
          model: 'anthropic/claude-opus-4-6',
          sandbox: {
            mode: 'all',
            scope: 'session',
            workspaceAccess: 'none',
            docker: {
              network: SANDBOX_EGRESS_NETWORK,
              binds: [],
              env: {
                HTTP_PROXY: SANDBOX_EGRESS_PROXY_URL,
                HTTPS_PROXY: SANDBOX_EGRESS_PROXY_URL,
                http_proxy: SANDBOX_EGRESS_PROXY_URL,
                https_proxy: SANDBOX_EGRESS_PROXY_URL,
                NO_PROXY: SANDBOX_NO_PROXY,
                no_proxy: SANDBOX_NO_PROXY,
              },
            },
          },
        },
      },
      tools: {
        profile: 'coding',
        allow: [
          'group:runtime',
          'group:fs',
          'group:web',
          'group:sessions',
          'group:memory',
          'group:media',
          'tts',
          'group:ui',
          'group:automation',
          'group:agents',
          'group:plugins',
        ],
        sandbox: {
          tools: {
            allow: [
              'group:runtime',
              'group:fs',
              'group:web',
              'group:sessions',
              'group:memory',
              'group:media',
              'tts',
              'group:ui',
              'group:automation',
              'group:agents',
              'group:plugins',
            ],
          },
        },
        exec: {
          host: 'sandbox',
          security: 'deny',
          ask: 'always',
          strictInlineEval: true,
        },
        elevated: { enabled: false },
      },
      meta: { lastTouchedVersion: '2026.6.10' },
    });
    const first = await ensureBaseline({ dataDir });
    expect(first.changed).toBe(true); // http endpoints were missing

    const after = await readOpenClawConfig(dataDir);
    expect((after.gateway as Record<string, unknown>).port).toBe(18789);
    expect((after.agents as { defaults: Record<string, unknown> }).defaults.model).toBe(
      'anthropic/claude-opus-4-6',
    );
    expect(after.meta).toEqual({ lastTouchedVersion: '2026.6.10' });

    const second = await ensureBaseline({ dataDir });
    expect(second.changed).toBe(false);
  });

  it('corrects drifted baseline and security values', async () => {
    await seedConfig({
      gateway: {
        mode: 'remote',
        auth: { mode: 'token' },
        http: { endpoints: { chatCompletions: { enabled: false }, responses: { enabled: true } } },
        controlUi: { allowedOrigins: ['*'] },
      },
      agents: { defaults: { sandbox: { mode: 'off', docker: { network: 'bridge' } } } },
      tools: {
        exec: { host: 'gateway', security: 'full', ask: 'off', askFallback: 'full' },
        elevated: { enabled: true },
      },
    });
    const { changed, config } = await ensureBaseline({ dataDir });
    expect(changed).toBe(true);
    const gateway = config.gateway as Record<string, unknown>;
    expect(gateway.mode).toBe('local');
    expect(gateway.http).toEqual({
      endpoints: { chatCompletions: { enabled: true }, responses: { enabled: true } },
    });
    expect(gateway.auth).toEqual({
      mode: 'token',
      rateLimit: {
        maxAttempts: 10,
        windowMs: 60000,
        lockoutMs: 300000,
        exemptLoopback: false,
      },
    });
    expect(gateway.controlUi).toEqual({
      allowedOrigins: ['http://127.0.0.1:18789', 'http://localhost:18789'],
    });
    const agents = config.agents as {
      defaults: {
        sandbox: {
          mode: string;
          docker: { network: string; env: Record<string, string> };
        };
      };
    };
    expect(agents.defaults.sandbox.mode).toBe('all');
    expect(agents.defaults.sandbox.docker.network).toBe(SANDBOX_EGRESS_NETWORK);
    expect(agents.defaults.sandbox.docker.env).toMatchObject({
      HTTP_PROXY: SANDBOX_EGRESS_PROXY_URL,
      HTTPS_PROXY: SANDBOX_EGRESS_PROXY_URL,
      NO_PROXY: SANDBOX_NO_PROXY,
    });
    const tools = config.tools as {
      exec: { host: string; security: string; ask: string; strictInlineEval: boolean };
      elevated: { enabled: boolean };
    };
    expect(tools.exec).toMatchObject({
      host: 'sandbox',
      security: 'full',
      ask: 'off',
      strictInlineEval: true,
    });
    expect('askFallback' in tools.exec).toBe(false);
    expect(tools.elevated.enabled).toBe(false);
  });
});

describe('setAgentModel', () => {
  const baseConfig = {
    gateway: { mode: 'local' },
    agents: {
      defaults: { model: 'anthropic/claude-opus-4-6' },
      list: [
        { id: 'main' },
        {
          id: 'testbot',
          name: 'testbot',
          workspace: '/home/node/.openclaw/workspace-testbot',
          agentDir: '/home/node/.openclaw/agents/testbot/agent',
          model: 'anthropic/claude-haiku-4-5',
        },
      ],
    },
  };

  it('updates only the target entry model', async () => {
    await seedConfig(baseConfig);
    const { changed } = await setAgentModel('testbot', 'anthropic/claude-opus-4-6', { dataDir });
    expect(changed).toBe(true);
    const after = await readOpenClawConfig(dataDir);
    const list = (after.agents as { list: Record<string, unknown>[] }).list;
    expect(list[0]).toEqual({ id: 'main' });
    expect(list[1]).toMatchObject({
      id: 'testbot',
      model: 'anthropic/claude-opus-4-6',
      workspace: '/home/node/.openclaw/workspace-testbot',
    });
  });

  it('is a no-op (no write) when the model already matches', async () => {
    await seedConfig(baseConfig);
    const before = await fs.stat(openclawConfigPath(dataDir));
    const { changed } = await setAgentModel('testbot', 'anthropic/claude-haiku-4-5', { dataDir });
    expect(changed).toBe(false);
    const after = await fs.stat(openclawConfigPath(dataDir));
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('throws for unregistered agents and missing agents.list', async () => {
    await seedConfig(baseConfig);
    await expect(setAgentModel('ghost', 'anthropic/claude-haiku-4-5', { dataDir })).rejects.toThrow(
      /not found in agents\.list/,
    );
    await seedConfig({ gateway: { mode: 'local' } });
    await expect(setAgentModel('testbot', 'x', { dataDir })).rejects.toBeInstanceOf(ConfigGenError);
  });
});

describe('setAgentSkills', () => {
  const baseConfig = {
    gateway: { mode: 'local' },
    agents: {
      defaults: { skills: ['memory'] },
      list: [
        { id: 'main', skills: ['baseline'] },
        {
          id: 'testbot',
          name: 'testbot',
          workspace: '/home/node/.openclaw/workspace-testbot',
          agentDir: '/home/node/.openclaw/agents/testbot/agent',
          model: 'anthropic/claude-haiku-4-5',
          skills: ['imagegen'],
        },
      ],
    },
  };

  it('replaces only the target agent skill allowlist', async () => {
    await seedConfig(baseConfig);
    const { changed } = await setAgentSkills('testbot', ['web-search', 'imagegen'], { dataDir });
    expect(changed).toBe(true);

    const after = await readOpenClawConfig(dataDir);
    const agents = after.agents as { defaults: unknown; list: Record<string, unknown>[] };
    expect(agents.defaults).toEqual({ skills: ['memory'] });
    expect(agents.list[0]).toEqual({ id: 'main', skills: ['baseline'] });
    expect(agents.list[1]).toMatchObject({
      id: 'testbot',
      skills: ['imagegen', 'web-search'],
      workspace: '/home/node/.openclaw/workspace-testbot',
    });
  });

  it('normalizes, persists a canonical sorted list, and is idempotent afterward', async () => {
    await seedConfig(baseConfig);
    const first = await setAgentSkills('testbot', [' slack ', 'imagegen', '', 'slack'], {
      dataDir,
    });
    expect(first.changed).toBe(true);
    const normalized = await readOpenClawConfig(dataDir);
    const entry = (normalized.agents as { list: Record<string, unknown>[] }).list[1]!;
    expect(entry.skills).toEqual(['imagegen', 'slack']);

    const before = await fs.stat(openclawConfigPath(dataDir));
    const second = await setAgentSkills('testbot', ['imagegen', 'slack'], { dataDir });
    expect(second.changed).toBe(false);
    const after = await fs.stat(openclawConfigPath(dataDir));
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('stores an empty allowlist to expose no skills', async () => {
    await seedConfig(baseConfig);
    const { changed } = await setAgentSkills('testbot', [], { dataDir });
    expect(changed).toBe(true);
    const after = await readOpenClawConfig(dataDir);
    const entry = (after.agents as { list: Record<string, unknown>[] }).list[1]!;
    expect(entry.skills).toEqual([]);
  });

  it('throws for unregistered agents and missing agents.list', async () => {
    await seedConfig(baseConfig);
    await expect(setAgentSkills('ghost', ['imagegen'], { dataDir })).rejects.toThrow(
      /not found in agents\.list/,
    );
    await seedConfig({ gateway: { mode: 'local' } });
    await expect(setAgentSkills('testbot', ['imagegen'], { dataDir })).rejects.toBeInstanceOf(
      ConfigGenError,
    );
  });
});

describe('setAgentToolGroups', () => {
  const baseConfig = {
    gateway: { mode: 'local' },
    agents: {
      list: [
        { id: 'main', tools: { allow: ['group:sessions'] } },
        {
          id: 'testbot',
          name: 'testbot',
          workspace: '/home/node/.openclaw/workspace-testbot',
          model: 'anthropic/claude-haiku-4-5',
          tools: {
            allow: ['group:runtime'],
            deny: ['nodes'],
            exec: { host: 'sandbox' },
            sandbox: { tools: { alsoAllow: ['message'] } },
          },
        },
      ],
    },
  };

  it('replaces only the target agent tool allowlist', async () => {
    await seedConfig(baseConfig);
    const { changed } = await setAgentToolGroups('testbot', ['group:media', 'group:web'], {
      dataDir,
    });
    expect(changed).toBe(true);

    const after = await readOpenClawConfig(dataDir);
    const list = (after.agents as { list: Record<string, unknown>[] }).list;
    expect(list[0]).toEqual({ id: 'main', tools: { allow: ['group:sessions'] } });
    expect(list[1]).toMatchObject({
      id: 'testbot',
      tools: {
        allow: ['group:media', 'tts', 'group:web'],
        deny: ['nodes'],
        exec: { host: 'sandbox' },
        sandbox: { tools: { alsoAllow: ['message'] } },
      },
    });
  });

  it('normalizes duplicates and is idempotent afterward', async () => {
    await seedConfig(baseConfig);
    const first = await setAgentToolGroups(
      'testbot',
      [' group:runtime ', 'group:runtime', '', 'group:fs'],
      { dataDir },
    );
    expect(first.changed).toBe(true);
    const normalized = await readOpenClawConfig(dataDir);
    const entry = (normalized.agents as { list: Record<string, unknown>[] }).list[1]!;
    expect((entry.tools as Record<string, unknown>).allow).toEqual(['group:runtime', 'group:fs']);

    const before = await fs.stat(openclawConfigPath(dataDir));
    const second = await setAgentToolGroups('testbot', ['group:runtime', 'group:fs'], {
      dataDir,
    });
    expect(second.changed).toBe(false);
    const after = await fs.stat(openclawConfigPath(dataDir));
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('creates tools.allow when an existing agent has no tools object and supports empty lists', async () => {
    await seedConfig({ agents: { list: [{ id: 'testbot' }] } });
    const { changed } = await setAgentToolGroups('testbot', [], { dataDir });
    expect(changed).toBe(true);
    const after = await readOpenClawConfig(dataDir);
    const entry = (after.agents as { list: Record<string, unknown>[] }).list[0]!;
    expect(entry.tools).toEqual({ allow: [] });
  });

  it('throws for unregistered agents, missing agents.list, and non-object tools', async () => {
    await seedConfig(baseConfig);
    await expect(setAgentToolGroups('ghost', ['group:web'], { dataDir })).rejects.toThrow(
      /not found in agents\.list/,
    );
    await seedConfig({ gateway: { mode: 'local' } });
    await expect(setAgentToolGroups('testbot', ['group:web'], { dataDir })).rejects.toBeInstanceOf(
      ConfigGenError,
    );
    await seedConfig({ agents: { list: [{ id: 'testbot', tools: 'bad' }] } });
    await expect(setAgentToolGroups('testbot', ['group:web'], { dataDir })).rejects.toThrow(
      /tools is not an object/,
    );
  });
});
