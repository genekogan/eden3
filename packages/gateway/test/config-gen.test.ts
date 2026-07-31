import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AGENT_TURN_TIMEOUT_SECONDS,
  CLAUDE_CLI_COMMAND,
  CLAUDE_CLI_FRESH_WATCHDOG_MAX_MS,
  ConfigGenError,
  EDEN_CHANNEL_RUNTIME_PLUGIN_ID,
  EDEN_CHANNEL_RUNTIME_PLUGIN_PATH,
  EDEN_CRON_PLUGIN_ID,
  EDEN_CRON_PLUGIN_PATH,
  EDEN_CRON_TOOL,
  MEMORY_DREAM_MODEL,
  REQUIRED_PLUGIN_ALLOWLIST,
  REQUIRED_PLUGIN_LOAD_PATHS,
  REQUIRED_SANDBOX_MEMORY_TOOLS,
  SANDBOX_EGRESS_NETWORK,
  SANDBOX_EGRESS_PROXY_URL,
  SANDBOX_MEDIA_IMAGE,
  SANDBOX_NO_PROXY,
  SANDBOX_PRUNE_IDLE_HOURS,
  SANDBOX_PRUNE_MAX_AGE_DAYS,
  SANDBOX_SHARED_ASSETS_CONTAINER_DIR,
  ensureBaseline,
  getModelAgentRuntime,
  getModelRuntimeCatalog,
  mutateOpenClawConfig,
  openClawEnvSecretRef,
  openclawConfigLockPath,
  openclawConfigPath,
  readOpenClawConfig,
  resolveDataDir,
  resolveSandboxAssetsDir,
  setAgentModel,
  setAgentSkills,
  setAgentToolGroups,
  setModelAgentRuntime,
  withOpenClawConfigLock,
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

const CONFIG_LOCK_WORKER = fileURLToPath(
  new URL('./fixtures/config-lock-worker.ts', import.meta.url),
);
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

interface WorkerOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runConfigLockWorker(
  mode: 'mutate' | 'crash',
  syncDir: string,
  workerId: string,
): Promise<WorkerOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', CONFIG_LOCK_WORKER, mode, dataDir, syncDir, workerId],
      { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function waitForReadyWorkers(syncDir: string, count: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const entries = await fs.readdir(syncDir);
    if (entries.filter((entry) => entry.startsWith('ready-')).length === count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${count} config-lock workers`);
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

  it('preflights the candidate before rename and observes the installed file afterward', async () => {
    await writeOpenClawConfig(dataDir, { version: 'old' });
    const observations: Array<{ candidate: string; live: unknown }> = [];
    await writeOpenClawConfig(
      dataDir,
      { version: 'new' },
      {
        validator: async (candidate) => {
          observations.push({
            candidate: path.basename(candidate),
            live: await readOpenClawConfig(dataDir),
          });
          expect(JSON.parse(await fs.readFile(candidate, 'utf8'))).toEqual({ version: 'new' });
        },
      },
    );
    expect(observations).toHaveLength(2);
    expect(observations[0]).toMatchObject({ candidate: expect.stringContaining('.tmp-'), live: { version: 'old' } });
    expect(observations[1]).toEqual({ candidate: 'openclaw.json', live: { version: 'new' } });
  });

  it('does not install a candidate rejected by runtime validation', async () => {
    await writeOpenClawConfig(dataDir, { version: 'last-good' });
    await expect(
      writeOpenClawConfig(
        dataDir,
        { version: 'bad' },
        { validator: async () => { throw new ConfigGenError('unknown schema key'); } },
      ),
    ).rejects.toThrow(/unknown schema key/);
    expect(await readOpenClawConfig(dataDir)).toEqual({ version: 'last-good' });
    expect((await fs.readdir(dataDir)).filter((entry) => entry.includes('.tmp-'))).toEqual([]);
  });

  it('throws ConfigGenError on malformed or non-object JSON', async () => {
    await fs.writeFile(openclawConfigPath(dataDir), '{nope');
    await expect(readOpenClawConfig(dataDir)).rejects.toBeInstanceOf(ConfigGenError);
    await fs.writeFile(openclawConfigPath(dataDir), '[1,2]');
    await expect(readOpenClawConfig(dataDir)).rejects.toBeInstanceOf(ConfigGenError);
  });
});

describe('OpenClaw config mutation serialization', () => {
  it('rebases independent baseline, runtime, skill, and tool writers onto the latest config', async () => {
    await seedConfig({
      operatorOwned: { preserve: true },
      agents: { list: [{ id: 'testbot' }] },
    });

    await Promise.all([
      ensureBaseline({ dataDir }),
      setModelAgentRuntime('anthropic/claude-haiku-4-5', 'claude-cli', { dataDir }),
      setAgentSkills('testbot', ['imagegen'], { dataDir }),
      setAgentToolGroups('testbot', ['group:web'], { dataDir }),
    ]);

    const config = await readOpenClawConfig(dataDir);
    expect(config.operatorOwned).toEqual({ preserve: true });
    expect((config.gateway as { mode: string }).mode).toBe('local');
    expect(
      ((config.agents as { defaults: { models: Record<string, { agentRuntime: unknown }> } })
        .defaults.models['anthropic/claude-haiku-4-5']!.agentRuntime),
    ).toEqual({ id: 'claude-cli' });
    expect((config.agents as { list: Array<Record<string, unknown>> }).list[0]).toMatchObject({
      id: 'testbot',
      skills: ['imagegen'],
      tools: { allow: ['group:web'] },
    });
  });

  it('preserves every adversarial read-modify-write across independent processes', async () => {
    const syncDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eden3-config-lock-sync-'));
    const workerIds = Array.from({ length: 8 }, (_, index) => `writer-${index}`);
    try {
      const workers = workerIds.map((workerId) =>
        runConfigLockWorker('mutate', syncDir, workerId),
      );
      await waitForReadyWorkers(syncDir, workerIds.length);
      await fs.writeFile(path.join(syncDir, 'start'), 'start\n');
      const outcomes = await Promise.all(workers);
      expect(outcomes).toEqual(
        workerIds.map(() => ({ code: 0, signal: null, stdout: '', stderr: '' })),
      );

      const config = await readOpenClawConfig(dataDir);
      const writers = config.concurrentWriters as Record<
        string,
        { workerId: string; observedBeforeDelay: number }
      >;
      expect(Object.keys(writers).sort()).toEqual([...workerIds].sort());
      expect(
        Object.values(writers)
          .map((entry) => entry.observedBeforeDelay)
          .sort((a, b) => a - b),
      ).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      expect((await fs.readdir(dataDir)).filter((entry) => entry.includes('.lock'))).toEqual([]);
      expect((await fs.readdir(dataDir)).filter((entry) => entry.includes('.tmp-'))).toEqual([]);
    } finally {
      await fs.rm(syncDir, { recursive: true, force: true });
    }
  }, 20_000);

  it('rolls back a failed mutation and releases the lock for the next writer', async () => {
    await writeOpenClawConfig(dataDir, { durable: 'before' });
    await expect(
      mutateOpenClawConfig(dataDir, (config) => {
        config.durable = 'uncommitted';
        throw new Error('abort mutation');
      }),
    ).rejects.toThrow('abort mutation');

    expect(await readOpenClawConfig(dataDir)).toEqual({ durable: 'before' });
    await mutateOpenClawConfig(dataDir, (config) => { config.afterAbort = true; });
    expect(await readOpenClawConfig(dataDir)).toEqual({ durable: 'before', afterAbort: true });
    await expect(fs.access(openclawConfigLockPath(dataDir))).rejects.toThrow();
  });

  it('recovers a valid lock abandoned by a dead local PID', async () => {
    await fs.writeFile(
      openclawConfigLockPath(dataDir),
      `${JSON.stringify({
        pid: 2_147_483_647,
        token: 'a'.repeat(32),
        createdAt: '2026-07-31T00:00:00.000Z',
      })}\n`,
      { mode: 0o600 },
    );
    await mutateOpenClawConfig(dataDir, (config) => { config.recovered = true; });
    expect(await readOpenClawConfig(dataDir)).toEqual({ recovered: true });
    await expect(fs.access(openclawConfigLockPath(dataDir))).rejects.toThrow();
  });

  it('rejects nested lock-taking APIs immediately and still releases the outer lock', async () => {
    await expect(
      withOpenClawConfigLock(dataDir, () => writeOpenClawConfig(dataDir, { nested: true })),
    ).rejects.toThrow(/nested OpenClaw config lock acquisition/);
    await writeOpenClawConfig(dataDir, { nextWriter: true });
    expect(await readOpenClawConfig(dataDir)).toEqual({ nextWriter: true });
  });
});

describe('openClawEnvSecretRef', () => {
  it('creates the strict OpenClaw 2026.7.1 env SecretRef shape', () => {
    expect(openClawEnvSecretRef('DISCORD_BOT_TOKEN')).toEqual({
      source: 'env',
      provider: 'default',
      id: 'DISCORD_BOT_TOKEN',
    });
  });

  it.each(['', 'discord_bot_token', '1TOKEN', 'TOKEN-NAME', `A${'B'.repeat(128)}`])(
    'rejects invalid env SecretRef id %j',
    (envVar) => {
      expect(() => openClawEnvSecretRef(envVar)).toThrow(ConfigGenError);
    },
  );
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
          timeoutSeconds: AGENT_TURN_TIMEOUT_SECONDS,
          cliBackends: {
            'claude-cli': {
              command: CLAUDE_CLI_COMMAND,
              reliability: {
                watchdog: {
                  fresh: { maxMs: CLAUDE_CLI_FRESH_WATCHDOG_MAX_MS },
                },
              },
            },
          },
          models: {
            'anthropic/claude-haiku-4-5': {
              params: { thinking: 'off' },
              agentRuntime: { id: 'openclaw' },
            },
            'anthropic/claude-sonnet-4-5': {
              params: { thinking: 'off' },
              agentRuntime: { id: 'openclaw' },
            },
            'anthropic/claude-sonnet-4-6': {
              params: { thinking: 'off' },
              agentRuntime: { id: 'claude-cli' },
            },
            'anthropic/claude-opus-4-6': {
              params: { thinking: 'off' },
              agentRuntime: { id: 'openclaw' },
            },
          },
          sandbox: {
            mode: 'all',
            scope: 'session',
            prune: {
              idleHours: SANDBOX_PRUNE_IDLE_HOURS,
              maxAgeDays: SANDBOX_PRUNE_MAX_AGE_DAYS,
            },
            workspaceAccess: 'rw',
            docker: {
              image: SANDBOX_MEDIA_IMAGE,
              network: SANDBOX_EGRESS_NETWORK,
              dangerouslyAllowExternalBindSources: true,
              env: {
                HTTP_PROXY: SANDBOX_EGRESS_PROXY_URL,
                HTTPS_PROXY: SANDBOX_EGRESS_PROXY_URL,
                http_proxy: SANDBOX_EGRESS_PROXY_URL,
                https_proxy: SANDBOX_EGRESS_PROXY_URL,
                NO_PROXY: SANDBOX_NO_PROXY,
                no_proxy: SANDBOX_NO_PROXY,
              },
              binds: [
                `${resolveSandboxAssetsDir(dataDir)}:${SANDBOX_SHARED_ASSETS_CONTAINER_DIR}:ro`,
              ],
            },
          },
          imageGenerationModel: {
            primary: 'fal/fal-ai/flux/dev',
            fallbacks: ['google/gemini-3-pro-image-preview'],
          },
          memorySearch: {
            enabled: true,
            provider: 'openai',
            sync: { embeddingBatchTimeoutSeconds: 600 },
            query: {
              hybrid: {
                mmr: { enabled: true },
                temporalDecay: { enabled: true, halfLifeDays: 30 },
              },
            },
          },
        },
      },
      memory: {
        backend: 'builtin',
        citations: 'auto',
      },
      models: {
        providers: {
          anthropic: {
            models: [
              { id: 'claude-haiku-4-5', name: 'claude-haiku-4-5' },
              { id: 'claude-sonnet-4-5', name: 'claude-sonnet-4-5' },
              { id: 'claude-sonnet-4-6', name: 'claude-sonnet-4-6' },
              { id: 'claude-opus-4-6', name: 'claude-opus-4-6' },
            ],
          },
        },
      },
      tools: {
        profile: 'coding',
        deny: ['cron'],
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
          EDEN_CRON_TOOL,
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
              EDEN_CRON_TOOL,
              'group:agents',
              'group:plugins',
              ...REQUIRED_SANDBOX_MEMORY_TOOLS,
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
      plugins: {
        allow: [...REQUIRED_PLUGIN_ALLOWLIST],
        load: { paths: [...REQUIRED_PLUGIN_LOAD_PATHS] },
        entries: {
          [EDEN_CRON_PLUGIN_ID]: { enabled: true },
          [EDEN_CHANNEL_RUNTIME_PLUGIN_ID]: {
            enabled: true,
            hooks: {
              allowConversationAccess: true,
              allowPromptInjection: true,
            },
            config: { accounts: [] },
          },
          'memory-core': {
            subagent: {
              allowModelOverride: true,
              allowedModels: [MEMORY_DREAM_MODEL],
            },
            config: {
              dreaming: {
                enabled: false,
                model: MEMORY_DREAM_MODEL,
                phases: {
                  light: { enabled: false },
                  deep: {
                    enabled: true,
                    minScore: 0.55,
                    minRecallCount: 1,
                    minUniqueQueries: 1,
                    recencyHalfLifeDays: 30,
                    limit: 10,
                  },
                  rem: { enabled: true },
                },
              },
            },
          },
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
            workspaceAccess: 'rw',
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
      meta: { lastTouchedVersion: '2026.7.1' },
    });
    const first = await ensureBaseline({ dataDir });
    expect(first.changed).toBe(true); // required baseline fields were missing

    const after = await readOpenClawConfig(dataDir);
    expect((after.gateway as Record<string, unknown>).port).toBe(18789);
    expect((after.agents as { defaults: Record<string, unknown> }).defaults.model).toBe(
      'anthropic/claude-opus-4-6',
    );
    expect(after.meta).toEqual({ lastTouchedVersion: '2026.7.1' });

    const second = await ensureBaseline({ dataDir });
    expect(second.changed).toBe(false);
  });

  it('keeps the global dream cron off and repairs legacy sandbox alsoAllow into allow', async () => {
    await seedConfig({
      tools: { sandbox: { tools: { alsoAllow: ['message'] } } },
      plugins: {
        entries: {
          'memory-core': {
            config: { dreaming: { enabled: true, operatorNote: 'preserve me' } },
          },
        },
      },
    });

    const { config } = await ensureBaseline({ dataDir });
    const sandboxTools = (
      config.tools as { sandbox: { tools: { allow: string[]; alsoAllow?: string[] } } }
    ).sandbox.tools;
    expect(sandboxTools.allow).toEqual([
      'group:runtime',
      'group:fs',
      'group:web',
      'group:sessions',
      'group:memory',
      'group:media',
      'tts',
      'group:ui',
      'group:automation',
      EDEN_CRON_TOOL,
      'group:agents',
      'group:plugins',
      ...REQUIRED_SANDBOX_MEMORY_TOOLS,
      'message',
    ]);
    expect(sandboxTools).not.toHaveProperty('alsoAllow');
    const dreaming = (
      config.plugins as {
        entries: { 'memory-core': { config: { dreaming: Record<string, unknown> } } };
      }
    ).entries['memory-core'].config.dreaming;
    expect(dreaming).toMatchObject({ enabled: false, operatorNote: 'preserve me' });
    expect(dreaming).not.toHaveProperty('managedSchedule');
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
    expect(agents.defaults.sandbox.docker).toMatchObject({
      image: SANDBOX_MEDIA_IMAGE,
      dangerouslyAllowExternalBindSources: true,
      binds: [
        `${resolveSandboxAssetsDir(dataDir)}:${SANDBOX_SHARED_ASSETS_CONTAINER_DIR}:ro`,
      ],
    });
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

  it('pins the persistent-home Claude command and preserves neighboring backend policy', async () => {
    await seedConfig({
      agents: {
        defaults: {
          cliBackends: {
            'claude-cli': {
              command: 'claude',
              output: 'jsonl',
              reliability: {
                watchdog: {
                  fresh: { minMs: 5_000 },
                  resume: { maxMs: 120_000 },
                },
              },
            },
          },
        },
      },
    });

    const first = await ensureBaseline({ dataDir });
    const defaults = (first.config.agents as { defaults: Record<string, unknown> }).defaults;
    expect(defaults.cliBackends).toMatchObject({
      'claude-cli': {
        command: CLAUDE_CLI_COMMAND,
        output: 'jsonl',
        reliability: {
          watchdog: {
            fresh: { minMs: 5_000, maxMs: CLAUDE_CLI_FRESH_WATCHDOG_MAX_MS },
            resume: { maxMs: 120_000 },
          },
        },
      },
    });

    const second = await ensureBaseline({ dataDir });
    expect(second.changed).toBe(false);
  });

  it('repairs an incomplete claude-cli backend into a schema-valid definition', async () => {
    await seedConfig({
      agents: { defaults: { cliBackends: { 'claude-cli': { output: 'jsonl' } } } },
    });
    const { config } = await ensureBaseline({ dataDir });
    expect(
      (config.agents as { defaults: { cliBackends: Record<string, unknown> } }).defaults
        .cliBackends['claude-cli'],
    ).toMatchObject({
      command: CLAUDE_CLI_COMMAND,
      output: 'jsonl',
      reliability: {
        watchdog: { fresh: { maxMs: CLAUDE_CLI_FRESH_WATCHDOG_MAX_MS } },
      },
    });
  });

  it('merges catalog registrations without overwriting entries or explicit runtime toggles', async () => {
    await seedConfig({
      models: {
        providers: {
          anthropic: {
            models: [
              { id: 'operator-model', name: 'Operator model', custom: true },
              { id: 'claude-opus-4-6', name: 'Custom Opus label', contextWindow: 123 },
            ],
          },
        },
      },
      agents: {
        defaults: {
          models: {
            'anthropic/claude-sonnet-4-6': {
              params: { thinking: 'adaptive', operator: true },
              agentRuntime: { id: 'openclaw' },
            },
          },
        },
      },
    });

    const first = await ensureBaseline({ dataDir });
    const providerModels = (
      first.config.models as {
        providers: { anthropic: { models: Array<Record<string, unknown>> } };
      }
    ).providers.anthropic.models;
    expect(providerModels.slice(0, 2)).toEqual([
      { id: 'operator-model', name: 'Operator model', custom: true },
      { id: 'claude-opus-4-6', name: 'Custom Opus label', contextWindow: 123 },
    ]);
    const modelConfigs = (
      first.config.agents as { defaults: { models: Record<string, Record<string, unknown>> } }
    ).defaults.models;
    expect(modelConfigs['anthropic/claude-sonnet-4-6']).toEqual({
      params: { thinking: 'adaptive', operator: true },
      agentRuntime: { id: 'openclaw' },
    });
    expect(await ensureBaseline({ dataDir })).toMatchObject({ changed: false });
  });

  it('migrates registered workspaces to Docker-host-visible dataDir paths', async () => {
    await seedConfig({
      agents: {
        list: [
          { id: 'main', workspace: '/home/node/.openclaw/workspace' },
          { id: 'testbot', workspace: '/home/node/.openclaw/workspace-testbot' },
        ],
      },
    });

    const { config } = await ensureBaseline({ dataDir });
    const list = (config.agents as { list: Record<string, unknown>[] }).list;
    expect(list[0]?.workspace).toBe(path.join(dataDir, 'workspace'));
    expect(list[1]?.workspace).toBe(path.join(dataDir, 'workspace-testbot'));
  });

  it('merges required plugin ids while preserving existing allowlist order and settings', async () => {
    await seedConfig({
      plugins: {
        allow: ['operator-plugin', 'discord'],
        entries: { 'operator-plugin': { enabled: true } },
      },
    });

    const first = await ensureBaseline({ dataDir });
    const plugins = first.config.plugins as Record<string, unknown>;
    expect(plugins.allow).toEqual([
      'operator-plugin',
      'discord',
      ...REQUIRED_PLUGIN_ALLOWLIST.filter((pluginId) => pluginId !== 'discord'),
    ]);
    expect(plugins.entries).toMatchObject({
      'operator-plugin': { enabled: true },
      [EDEN_CHANNEL_RUNTIME_PLUGIN_ID]: {
        enabled: true,
        hooks: {
          allowConversationAccess: true,
          allowPromptInjection: true,
        },
      },
      'memory-core': {
        subagent: {
          allowModelOverride: true,
          allowedModels: [MEMORY_DREAM_MODEL],
        },
        config: { dreaming: { enabled: false, model: MEMORY_DREAM_MODEL } },
      },
    });

    const second = await ensureBaseline({ dataDir });
    expect(second.changed).toBe(false);
  });

  it('restores the load-bearing channel runtime plugin path and hook permissions', async () => {
    await seedConfig({
      plugins: {
        allow: ['operator-plugin'],
        load: { paths: ['/opt/operator/plugin'] },
        entries: {
          [EDEN_CHANNEL_RUNTIME_PLUGIN_ID]: {
            enabled: false,
            hooks: {
              allowConversationAccess: false,
              allowPromptInjection: false,
            },
            config: null,
          },
        },
      },
    });

    const first = await ensureBaseline({ dataDir });
    const plugins = first.config.plugins as {
      allow: string[];
      load: { paths: string[] };
      entries: Record<string, unknown>;
    };
    expect(plugins.allow).toContain(EDEN_CHANNEL_RUNTIME_PLUGIN_ID);
    expect(plugins.load.paths).toEqual([
      '/opt/operator/plugin',
      EDEN_CRON_PLUGIN_PATH,
      EDEN_CHANNEL_RUNTIME_PLUGIN_PATH,
    ]);
    expect(plugins.entries[EDEN_CHANNEL_RUNTIME_PLUGIN_ID]).toEqual({
      enabled: true,
      hooks: {
        allowConversationAccess: true,
        allowPromptInjection: true,
      },
      config: { accounts: [] },
    });

    const second = await ensureBaseline({ dataDir });
    expect(second.changed).toBe(false);
  });

  it('denies native gateway cron while preserving operator denies and eden_cron', async () => {
    await seedConfig({ tools: { deny: ['canvas'] } });
    const first = await ensureBaseline({ dataDir });
    const tools = first.config.tools as { allow: string[]; deny: string[] };
    expect(tools.deny).toEqual(['canvas', 'cron']);
    expect(tools.allow).toContain(EDEN_CRON_TOOL);
    expect(tools.allow).toContain('group:automation');
    const second = await ensureBaseline({ dataDir });
    expect(second.changed).toBe(false);
  });

  it.each([
    { plugins: [] },
    { plugins: { allow: 'discord' } },
    { plugins: { allow: ['discord', 7] } },
  ])('rejects a schema-invalid plugin allowlist without writing it: %j', async (seed) => {
    await seedConfig(seed);
    await expect(ensureBaseline({ dataDir })).rejects.toBeInstanceOf(ConfigGenError);
    expect(await readOpenClawConfig(dataDir)).toEqual(seed);
  });
});

describe('model-scoped agentRuntime', () => {
  it('reads catalog defaults without mutating a missing config', async () => {
    expect(await getModelRuntimeCatalog({ dataDir })).toEqual([
      { model: 'anthropic/claude-haiku-4-5', agentRuntime: 'openclaw' },
      { model: 'anthropic/claude-sonnet-4-5', agentRuntime: 'openclaw' },
      { model: 'anthropic/claude-sonnet-4-6', agentRuntime: 'claude-cli' },
      { model: 'anthropic/claude-opus-4-6', agentRuntime: 'openclaw' },
    ]);
    expect(await readOpenClawConfig(dataDir)).toEqual({});
  });

  it('hot-toggles both directions and keeps all four registration spots', async () => {
    const api = await setModelAgentRuntime(
      'anthropic/claude-sonnet-4-6',
      'openclaw',
      { dataDir },
    );
    expect(api).toMatchObject({ changed: true, agentRuntime: 'openclaw' });
    expect(await getModelAgentRuntime('anthropic/claude-sonnet-4-6', { dataDir })).toBe(
      'openclaw',
    );

    const subscription = await setModelAgentRuntime(
      'anthropic/claude-sonnet-4-6',
      'claude-cli',
      { dataDir },
    );
    expect(subscription.changed).toBe(true);
    const config = await readOpenClawConfig(dataDir);
    expect(
      (config.models as { providers: { anthropic: { models: Array<{ id: string }> } } })
        .providers.anthropic.models.map((entry) => entry.id),
    ).toContain('claude-sonnet-4-6');
    const registered = (
      config.agents as { defaults: { models: Record<string, Record<string, unknown>> } }
    ).defaults.models['anthropic/claude-sonnet-4-6'];
    expect(registered).toEqual({
      params: { thinking: 'off' },
      agentRuntime: { id: 'claude-cli' },
    });
    expect(
      await setModelAgentRuntime('anthropic/claude-sonnet-4-6', 'claude-cli', { dataDir }),
    ).toMatchObject({ changed: false });
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

  it('re-attests non-secret hosted channel model/runtime mappings on every toggle', async () => {
    const connectionId = '11111111-1111-4111-8111-111111111111';
    await seedConfig({
      agents: {
        defaults: {
          models: {
            'anthropic/claude-haiku-4-5': { agentRuntime: { id: 'openclaw' } },
            'anthropic/claude-sonnet-4-6': { agentRuntime: { id: 'openclaw' } },
          },
        },
        list: [{ id: 'testbot', model: 'anthropic/claude-haiku-4-5' }],
      },
      channels: {
        discord: {
          enabled: true,
          accounts: { testbot: { enabled: true, groupPolicy: 'disabled' } },
        },
      },
      bindings: [{ agentId: 'testbot', match: { channel: 'discord', accountId: 'testbot' } }],
      plugins: {
        entries: {
          [EDEN_CHANNEL_RUNTIME_PLUGIN_ID]: {
            config: {
              accounts: [
                {
                  channel: 'discord',
                  accountId: 'testbot',
                  connectionId,
                  agentId: 'testbot',
                  model: 'anthropic/claude-haiku-4-5',
                  agentRuntime: 'openclaw',
                },
              ],
            },
          },
        },
      },
    });

    await setAgentModel('testbot', 'anthropic/claude-sonnet-4-6', { dataDir });
    let config = await readOpenClawConfig(dataDir);
    let mapping = (
      config.plugins as {
        entries: Record<string, { config: { accounts: Array<Record<string, unknown>> } }>;
      }
    ).entries[EDEN_CHANNEL_RUNTIME_PLUGIN_ID]!.config.accounts[0]!;
    expect(mapping).toMatchObject({
      connectionId,
      model: 'anthropic/claude-sonnet-4-6',
      agentRuntime: 'openclaw',
    });

    await setModelAgentRuntime('anthropic/claude-sonnet-4-6', 'claude-cli', { dataDir });
    config = await readOpenClawConfig(dataDir);
    mapping = (
      config.plugins as {
        entries: Record<string, { config: { accounts: Array<Record<string, unknown>> } }>;
      }
    ).entries[EDEN_CHANNEL_RUNTIME_PLUGIN_ID]!.config.accounts[0]!;
    expect(mapping).toMatchObject({
      connectionId,
      model: 'anthropic/claude-sonnet-4-6',
      agentRuntime: 'claude-cli',
    });
  });

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

  it('exposes the metered cron tool only with the automation capability', async () => {
    await seedConfig(baseConfig);
    await setAgentToolGroups('testbot', ['group:automation', 'group:web'], { dataDir });
    let after = await readOpenClawConfig(dataDir);
    let entry = (after.agents as { list: Array<{ tools: { allow: string[] } }> }).list[1]!;
    expect(entry.tools.allow).toEqual(['group:automation', EDEN_CRON_TOOL, 'group:web']);

    await setAgentToolGroups('testbot', ['group:web'], { dataDir });
    after = await readOpenClawConfig(dataDir);
    entry = (after.agents as { list: Array<{ tools: { allow: string[] } }> }).list[1]!;
    expect(entry.tools.allow).toEqual(['group:web']);
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
