import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ConfigGenError,
  ensureBaseline,
  openclawConfigPath,
  readOpenClawConfig,
  resolveDataDir,
  setAgentModel,
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
        auth: { mode: 'token' },
        http: {
          endpoints: {
            chatCompletions: { enabled: true },
            responses: { enabled: true },
          },
        },
      },
    });
    expect(await readOpenClawConfig(dataDir)).toEqual(config);
  });

  it('is idempotent and preserves unrelated keys', async () => {
    await seedConfig({
      gateway: { mode: 'local', port: 18789, auth: { mode: 'token' } },
      agents: { defaults: { model: 'anthropic/claude-opus-4-6' } },
      meta: { lastTouchedVersion: '2026.6.10' },
    });
    const first = await ensureBaseline({ dataDir });
    expect(first.changed).toBe(true); // http endpoints were missing

    const after = await readOpenClawConfig(dataDir);
    expect((after.gateway as Record<string, unknown>).port).toBe(18789);
    expect(after.agents).toEqual({ defaults: { model: 'anthropic/claude-opus-4-6' } });
    expect(after.meta).toEqual({ lastTouchedVersion: '2026.6.10' });

    const second = await ensureBaseline({ dataDir });
    expect(second.changed).toBe(false);
  });

  it('corrects drifted baseline values', async () => {
    await seedConfig({
      gateway: {
        mode: 'remote',
        auth: { mode: 'token' },
        http: { endpoints: { chatCompletions: { enabled: false }, responses: { enabled: true } } },
      },
    });
    const { changed, config } = await ensureBaseline({ dataDir });
    expect(changed).toBe(true);
    const gateway = config.gateway as Record<string, unknown>;
    expect(gateway.mode).toBe('local');
    expect(gateway.http).toEqual({
      endpoints: { chatCompletions: { enabled: true }, responses: { enabled: true } },
    });
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
