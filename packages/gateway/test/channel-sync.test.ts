import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigGenError, openclawConfigPath, readOpenClawConfig } from '../src/config-gen';
import { disableDiscordChannel, ensureDiscordChannel } from '../src/channel-sync';

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eden3-channel-sync-'));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function seedConfig(config: Record<string, unknown>): Promise<void> {
  await fs.writeFile(openclawConfigPath(dataDir), JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
}

describe('ensureDiscordChannel', () => {
  it('writes enabled channel, env token ref, allowlist policy, and a DM binding', async () => {
    await seedConfig({ gateway: { mode: 'local' } });
    const { changed, config } = await ensureDiscordChannel({
      dataDir,
      tokenEnvVar: 'DISCORD_BOT_TOKEN',
      allowFrom: ['404322488215142410'],
      bindAgentId: 'abraham',
    });
    expect(changed).toBe(true);
    expect(config.channels).toEqual({
      discord: {
        enabled: true,
        dmPolicy: 'allowlist',
        allowFrom: ['404322488215142410'],
      },
    });
    expect(config.bindings).toEqual([
      {
        agentId: 'abraham',
        match: { channel: 'discord', peer: { kind: 'dm', id: '404322488215142410' } },
      },
    ]);
    // No token key at all (bare-env fallback; the env-ref shape crash-loops
    // this OpenClaw release) and no token value anywhere in the file.
    const raw = await fs.readFile(openclawConfigPath(dataDir), 'utf8');
    expect(raw).not.toContain('token');
    // Unrelated keys pass through.
    expect((await readOpenClawConfig(dataDir)).gateway).toEqual({ mode: 'local' });
  });

  it('is idempotent, rebinds an existing DM binding, and preserves other bindings', async () => {
    await seedConfig({
      bindings: [
        { agentId: 'other', match: { channel: 'telegram', peer: { kind: 'dm', id: '99' } } },
        {
          agentId: 'old-agent',
          match: { channel: 'discord', peer: { kind: 'dm', id: '404322488215142410' } },
        },
      ],
    });
    const first = await ensureDiscordChannel({
      dataDir,
      tokenEnvVar: 'DISCORD_BOT_TOKEN',
      allowFrom: ['404322488215142410'],
      bindAgentId: 'abraham',
    });
    expect(first.changed).toBe(true);
    const bindings = first.config.bindings as Array<{ agentId: string }>;
    expect(bindings).toHaveLength(2); // rebound in place, telegram untouched
    expect(bindings.map((b) => b.agentId).sort()).toEqual(['abraham', 'other']);

    const second = await ensureDiscordChannel({
      dataDir,
      tokenEnvVar: 'DISCORD_BOT_TOKEN',
      allowFrom: ['404322488215142410'],
      bindAgentId: 'abraham',
    });
    expect(second.changed).toBe(false);
  });

  it('requires at least one allowFrom id and the canonical token env name', async () => {
    await expect(
      ensureDiscordChannel({ dataDir, tokenEnvVar: 'DISCORD_BOT_TOKEN', allowFrom: [] }),
    ).rejects.toThrow(ConfigGenError);
    await expect(
      ensureDiscordChannel({ dataDir, tokenEnvVar: 'X', allowFrom: ['1234567'] }),
    ).rejects.toThrow(ConfigGenError);
  });

  it('strips a leftover token key from the earlier env-ref attempt', async () => {
    await seedConfig({
      channels: {
        discord: { enabled: true, token: { source: 'env', id: 'DISCORD_BOT_TOKEN' } },
      },
    });
    const { config } = await ensureDiscordChannel({
      dataDir,
      tokenEnvVar: 'DISCORD_BOT_TOKEN',
      allowFrom: ['404322488215142410'],
    });
    const discord = (config.channels as Record<string, Record<string, unknown>>).discord!;
    expect('token' in discord).toBe(false);
  });
});

describe('disableDiscordChannel', () => {
  it('disables the channel and strips discord bindings only', async () => {
    await seedConfig({
      channels: {
        discord: { enabled: true, token: { source: 'env', id: 'X' } },
        telegram: { enabled: true },
      },
      bindings: [
        { agentId: 'a', match: { channel: 'discord', peer: { kind: 'dm', id: '1' } } },
        { agentId: 'b', match: { channel: 'telegram', peer: { kind: 'dm', id: '2' } } },
      ],
    });
    const { changed, config } = await disableDiscordChannel({ dataDir });
    expect(changed).toBe(true);
    const channels = config.channels as Record<string, Record<string, unknown>>;
    expect(channels.discord!.enabled).toBe(false);
    expect(channels.telegram!.enabled).toBe(true);
    expect(config.bindings).toEqual([
      { agentId: 'b', match: { channel: 'telegram', peer: { kind: 'dm', id: '2' } } },
    ]);
  });

  it('no-ops on a config without discord', async () => {
    await seedConfig({ gateway: { mode: 'local' } });
    const { changed } = await disableDiscordChannel({ dataDir });
    expect(changed).toBe(false);
  });
});
