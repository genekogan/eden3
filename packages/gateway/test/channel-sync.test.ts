import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ConfigGenError,
  EDEN_CHANNEL_RUNTIME_PLUGIN_ID,
  EDEN_CHANNEL_RUNTIME_PLUGIN_PATH,
  openclawConfigPath,
  readOpenClawConfig,
} from '../src/config-gen';
import { randomBytes } from 'node:crypto';

import { deriveCapabilityKey } from '../src/channel-secret-capability';
import {
  EDEN_CHANNEL_SECRET_PROVIDER_ID,
  disableDiscordChannel,
  ensureDiscordChannel,
  ensureHostedChannelAccount,
  hostedChannelSecretRef,
  removeHostedChannelAccount,
} from '../src/channel-sync';

let dataDir: string;

// Hosted-account minting requires the vault key; capability ids are derived
// from it. Fix a synthetic key for the whole suite so expected == actual.
const TEST_VAULT_KEY = randomBytes(32).toString('base64');
const TEST_CAP_KEY = deriveCapabilityKey(TEST_VAULT_KEY);
const priorVaultKey = process.env.CHANNEL_TOKEN_ENCRYPTION_KEY;

beforeEach(async () => {
  process.env.CHANNEL_TOKEN_ENCRYPTION_KEY = TEST_VAULT_KEY;
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eden3-channel-sync-'));
});

afterEach(async () => {
  if (priorVaultKey === undefined) delete process.env.CHANNEL_TOKEN_ENCRYPTION_KEY;
  else process.env.CHANNEL_TOKEN_ENCRYPTION_KEY = priorVaultKey;
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
        token: {
          source: 'env',
          provider: 'default',
          id: 'DISCORD_BOT_TOKEN',
        },
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
    const raw = await fs.readFile(openclawConfigPath(dataDir), 'utf8');
    expect(raw).toContain('DISCORD_BOT_TOKEN');
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

  it('requires at least one allowFrom id and a schema-valid token env name', async () => {
    await expect(
      ensureDiscordChannel({ dataDir, tokenEnvVar: 'DISCORD_BOT_TOKEN', allowFrom: [] }),
    ).rejects.toThrow(ConfigGenError);
    await expect(
      ensureDiscordChannel({ dataDir, tokenEnvVar: 'discord-token', allowFrom: ['1234567'] }),
    ).rejects.toThrow(ConfigGenError);
  });

  it('stores only the env name and never resolves its plaintext value', async () => {
    const envVar = 'EDEN3_TEST_DISCORD_TOKEN';
    const secretValue = 'plaintext-discord-secret-must-not-be-written';
    const previousValue = process.env[envVar];
    process.env[envVar] = secretValue;
    try {
      await ensureDiscordChannel({ dataDir, tokenEnvVar: envVar, allowFrom: ['1234567'] });
      const raw = await fs.readFile(openclawConfigPath(dataDir), 'utf8');
      expect(raw).toContain(envVar);
      expect(raw).not.toContain(secretValue);
    } finally {
      if (previousValue === undefined) delete process.env[envVar];
      else process.env[envVar] = previousValue;
    }
  });

  it('upgrades an incomplete legacy env ref to the strict 2026.7.1 shape', async () => {
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
    expect(discord.token).toEqual({
      source: 'env',
      provider: 'default',
      id: 'DISCORD_BOT_TOKEN',
    });
  });
});

describe('disableDiscordChannel', () => {
  it('disables the channel and strips discord bindings only', async () => {
    await seedConfig({
      channels: {
        discord: {
          enabled: true,
          token: { source: 'env', provider: 'default', id: 'DISCORD_BOT_TOKEN' },
        },
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

describe('hosted named channel accounts', () => {
  const connectionA = '11111111-1111-4111-8111-111111111111';
  const connectionB = '22222222-2222-4222-8222-222222222222';
  const accountA = 'aaaaaaaa-1111-4111-8111-111111111111';
  const accountB = 'bbbbbbbb-2222-4222-8222-222222222222';
  const hostedAgents = (agentIds: string[]) => ({
    agents: {
      defaults: {
        model: 'anthropic/claude-haiku-4-5',
        models: {
          'anthropic/claude-haiku-4-5': { agentRuntime: { id: 'openclaw' } },
        },
      },
      list: agentIds.map((id) => ({ id, model: 'anthropic/claude-haiku-4-5' })),
    },
  });

  it('preserves every account and binding under concurrent channel mutations', async () => {
    const accounts = Array.from({ length: 12 }, (_, index) => {
      const suffix = String(index + 1).padStart(12, '0');
      return {
        channel: index % 2 === 0 ? 'discord' as const : 'telegram' as const,
        runtimeAccountId: `concurrent-${index}`,
        connectionId: `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`,
        accountId: `bbbbbbbb-bbbb-4bbb-8bbb-${suffix}`,
      };
    });
    await seedConfig({
      operator: { untouched: true },
      ...hostedAgents(accounts.map((account) => account.runtimeAccountId)),
    });

    await Promise.all(
      accounts.map((account) =>
        ensureHostedChannelAccount({
          dataDir,
          ...account,
          capabilityEpoch: 'c1',
          bindAgentId: account.runtimeAccountId,
          dmPolicy: 'pairing',
          allowFrom: [],
        }),
      ),
    );

    const config = await readOpenClawConfig(dataDir);
    const channels = config.channels as Record<
      string,
      { accounts: Record<string, unknown> }
    >;
    for (const channel of ['discord', 'telegram'] as const) {
      expect(Object.keys(channels[channel]!.accounts).sort()).toEqual(
        accounts
          .filter((account) => account.channel === channel)
          .map((account) => account.runtimeAccountId)
          .sort(),
      );
    }
    expect(config.bindings).toHaveLength(accounts.length);
    expect(new Set((config.bindings as Array<{ agentId: string }>).map((entry) => entry.agentId)))
      .toEqual(new Set(accounts.map((account) => account.runtimeAccountId)));
    expect((config.plugins as { allow: string[] }).allow).toEqual(
      expect.arrayContaining(['discord', 'telegram']),
    );
    expect(config.operator).toEqual({ untouched: true });
  });

  it('projects two isolated Discord bots with exec SecretRefs and account bindings', async () => {
    const plaintextLegacyToken = 'plaintext-legacy-token-must-be-removed';
    await seedConfig({
      ...hostedAgents(['agent-one', 'agent-two']),
      session: { dmScope: 'per-channel-peer' },
      plugins: { allow: ['operator-plugin'] },
      channels: {
        discord: {
          token: plaintextLegacyToken,
          dmPolicy: 'allowlist',
          allowFrom: ['999999'],
        },
      },
      bindings: [{ agentId: 'other', match: { channel: 'slack', accountId: 'work' } }],
    });

    await ensureHostedChannelAccount({
      dataDir,
      channel: 'discord',
      runtimeAccountId: 'agent-one',
      connectionId: connectionA,
      accountId: accountA,
      capabilityEpoch: 'c1',
      label: 'First bot',
      bindAgentId: 'agent-one',
      bindingId: '33333333-3333-4333-8333-333333333333',
      dmPolicy: 'allowlist',
      allowFrom: ['404322488215142410'],
    });
    const second = await ensureHostedChannelAccount({
      dataDir,
      channel: 'discord',
      runtimeAccountId: 'agent-two',
      connectionId: connectionB,
      accountId: accountB,
      capabilityEpoch: 'c1',
      label: 'Second bot',
      bindAgentId: 'agent-two',
      dmPolicy: 'pairing',
      allowFrom: [],
    });

    const config = second.config;
    expect((config.session as Record<string, unknown>).dmScope).toBe(
      'per-account-channel-peer',
    );
    expect((config.plugins as { allow: string[] }).allow).toEqual([
      'operator-plugin',
      'discord',
      EDEN_CHANNEL_RUNTIME_PLUGIN_ID,
    ]);
    expect(
      (
        config.plugins as {
          entries: Record<string, { enabled: boolean; hooks: Record<string, boolean> }>;
        }
      ).entries[EDEN_CHANNEL_RUNTIME_PLUGIN_ID],
    ).toMatchObject({
      enabled: true,
      hooks: { allowConversationAccess: true, allowPromptInjection: true },
    });
    expect(
      (config.plugins as { load: { paths: string[] } }).load.paths,
    ).toContain(EDEN_CHANNEL_RUNTIME_PLUGIN_PATH);
    expect(
      (config.secrets as { providers: Record<string, unknown> }).providers[
        EDEN_CHANNEL_SECRET_PROVIDER_ID
      ],
    ).toEqual({
      source: 'exec',
      command: '/usr/local/bin/eden-channel-secret-resolver',
      args: ['--socket', '/run/eden3/channel-secrets.sock'],
      passEnv: ['EDEN_CHANNEL_REQUESTER_KEY', 'EDEN_CHANNEL_REQUESTER_INSTANCE_ID'],
      jsonOnly: true,
      timeoutMs: 5000,
      noOutputTimeoutMs: 5000,
      maxOutputBytes: 262144,
    });

    const discord = (config.channels as Record<string, Record<string, unknown>>).discord!;
    expect(discord.token).toBeUndefined();
    expect(discord.allowFrom).toBeUndefined();
    expect(discord.dmPolicy).toBeUndefined();
    expect(discord.defaultAccount).toBe('agent-one');
    expect(discord.configWrites).toBe(false);
    const accounts = discord.accounts as Record<string, Record<string, unknown>>;
    expect(accounts['agent-one']).toMatchObject({
      enabled: true,
      name: 'First bot',
      token: hostedChannelSecretRef(
        {
          connectionId: connectionA,
          accountId: accountA,
          channel: 'discord',
          runtimeAccountId: 'agent-one',
          epoch: 'c1',
        },
        TEST_CAP_KEY,
      ),
      dmPolicy: 'allowlist',
      allowFrom: ['404322488215142410'],
      groupPolicy: 'disabled',
    });
    expect(accounts['agent-one']).not.toHaveProperty('guilds');
    expect(accounts['agent-two']).toMatchObject({
      enabled: true,
      token: hostedChannelSecretRef(
        {
          connectionId: connectionB,
          accountId: accountB,
          channel: 'discord',
          runtimeAccountId: 'agent-two',
          epoch: 'c1',
        },
        TEST_CAP_KEY,
      ),
      dmPolicy: 'pairing',
      allowFrom: [],
      groupPolicy: 'disabled',
    });
    expect(config.bindings).toEqual([
      { agentId: 'other', match: { channel: 'slack', accountId: 'work' } },
      { agentId: 'agent-one', match: { channel: 'discord', accountId: 'agent-one' } },
      { agentId: 'agent-two', match: { channel: 'discord', accountId: 'agent-two' } },
    ]);
    expect(
      (
        config.plugins as {
          entries: Record<string, { config: { accounts: unknown[] } }>;
        }
      ).entries[EDEN_CHANNEL_RUNTIME_PLUGIN_ID]!.config.accounts,
    ).toEqual([
      {
        channel: 'discord',
        accountId: 'agent-one',
        connectionId: connectionA,
        agentId: 'agent-one',
        bindingId: '33333333-3333-4333-8333-333333333333',
        model: 'anthropic/claude-haiku-4-5',
        agentRuntime: 'openclaw',
      },
      {
        channel: 'discord',
        accountId: 'agent-two',
        connectionId: connectionB,
        agentId: 'agent-two',
        model: 'anthropic/claude-haiku-4-5',
        agentRuntime: 'openclaw',
      },
    ]);

    const raw = await fs.readFile(openclawConfigPath(dataDir), 'utf8');
    expect(raw).not.toContain(plaintextLegacyToken);
    expect(raw).toContain(`channel/${connectionA}`);
    expect(raw).toContain(`channel/${connectionB}`);

    const replay = await ensureHostedChannelAccount({
      dataDir,
      channel: 'discord',
      runtimeAccountId: 'agent-two',
      connectionId: connectionB,
      accountId: accountB,
      capabilityEpoch: 'c1',
      label: 'Second bot',
      bindAgentId: 'agent-two',
      dmPolicy: 'pairing',
      allowFrom: [],
    });
    expect(replay.changed).toBe(false);
  });

  it('projects Telegram botToken per named account and allows a pairing queue policy', async () => {
    await seedConfig({
      ...hostedAgents(['telegram-agent']),
      plugins: { allow: ['discord'] },
    });
    const { config } = await ensureHostedChannelAccount({
      dataDir,
      channel: 'telegram',
      runtimeAccountId: 'telegram-agent',
      connectionId: connectionA,
      accountId: accountA,
      capabilityEpoch: 'c1',
      label: 'Telegram bot',
      bindAgentId: 'telegram-agent',
      dmPolicy: 'pairing',
      allowFrom: [],
    });
    const telegram = (config.channels as Record<string, Record<string, unknown>>).telegram!;
    expect((config.plugins as { allow: string[] }).allow).toEqual([
      'discord',
      'telegram',
      EDEN_CHANNEL_RUNTIME_PLUGIN_ID,
    ]);
    expect(telegram.defaultAccount).toBe('telegram-agent');
    expect(telegram.streaming).toEqual({ mode: 'off' });
    expect(
      (telegram.accounts as Record<string, Record<string, unknown>>)['telegram-agent'],
    ).toMatchObject({
      botToken: hostedChannelSecretRef(
        {
          connectionId: connectionA,
          accountId: accountA,
          channel: 'telegram',
          runtimeAccountId: 'telegram-agent',
          epoch: 'c1',
        },
        TEST_CAP_KEY,
      ),
      dmPolicy: 'pairing',
      allowFrom: [],
      enabled: true,
    });
    expect(config.bindings).toContainEqual({
      agentId: 'telegram-agent',
      match: { channel: 'telegram', accountId: 'telegram-agent' },
    });
  });

  it('replaces one hosted SecretRef when its durable capability epoch advances', async () => {
    await seedConfig(hostedAgents(['agent-one']));
    const first = await ensureHostedChannelAccount({
      dataDir,
      channel: 'discord',
      runtimeAccountId: 'agent-one',
      connectionId: connectionA,
      accountId: accountA,
      capabilityEpoch: 'c1',
      label: 'Rotating bot',
      bindAgentId: 'agent-one',
      dmPolicy: 'pairing',
      allowFrom: [],
    });
    const firstToken = (
      (first.config.channels as Record<string, Record<string, unknown>>).discord!
        .accounts as Record<string, { token: { id: string } }>
    )['agent-one']!.token;

    const rotated = await ensureHostedChannelAccount({
      dataDir,
      channel: 'discord',
      runtimeAccountId: 'agent-one',
      connectionId: connectionA,
      accountId: accountA,
      capabilityEpoch: 'c2',
      label: 'Rotating bot',
      bindAgentId: 'agent-one',
      dmPolicy: 'pairing',
      allowFrom: [],
    });
    const rotatedToken = (
      (rotated.config.channels as Record<string, Record<string, unknown>>).discord!
        .accounts as Record<string, { token: { id: string } }>
    )['agent-one']!.token;

    expect(rotated.changed).toBe(true);
    expect(rotatedToken.id).not.toBe(firstToken.id);
    expect(rotatedToken).toEqual(hostedChannelSecretRef({
      connectionId: connectionA,
      accountId: accountA,
      channel: 'discord',
      runtimeAccountId: 'agent-one',
      epoch: 'c2',
    }, TEST_CAP_KEY));

    const replay = await ensureHostedChannelAccount({
      dataDir,
      channel: 'discord',
      runtimeAccountId: 'agent-one',
      connectionId: connectionA,
      accountId: accountA,
      capabilityEpoch: 'c2',
      label: 'Rotating bot',
      bindAgentId: 'agent-one',
      dmPolicy: 'pairing',
      allowFrom: [],
    });
    expect(replay.changed).toBe(false);
  });

  it('pauses and deletes only the selected account while keeping the other bot routed', async () => {
    await seedConfig(hostedAgents(['agent-one', 'agent-two']));
    for (const [runtimeAccountId, connectionId, accountId] of [
      ['agent-one', connectionA, accountA],
      ['agent-two', connectionB, accountB],
    ] as const) {
      await ensureHostedChannelAccount({
        dataDir,
        channel: 'discord',
        runtimeAccountId,
        connectionId,
        accountId,
        capabilityEpoch: 'c1',
        bindAgentId: runtimeAccountId,
        dmPolicy: 'pairing',
        allowFrom: [],
      });
    }

    const paused = await removeHostedChannelAccount({
      dataDir,
      channel: 'discord',
      runtimeAccountId: 'agent-one',
    });
    const pausedDiscord = (
      paused.config.channels as Record<string, Record<string, unknown>>
    ).discord!;
    expect(
      (pausedDiscord.accounts as Record<string, Record<string, unknown>>)['agent-one']!.enabled,
    ).toBe(false);
    expect(
      (pausedDiscord.accounts as Record<string, Record<string, unknown>>)['agent-two']!.enabled,
    ).toBe(true);
    expect(pausedDiscord.enabled).toBe(true);
    expect(paused.config.bindings).toEqual([
      { agentId: 'agent-two', match: { channel: 'discord', accountId: 'agent-two' } },
    ]);

    const deletedOne = await removeHostedChannelAccount({
      dataDir,
      channel: 'discord',
      runtimeAccountId: 'agent-one',
      deleteAccount: true,
    });
    const remainingDiscord = (
      deletedOne.config.channels as Record<string, Record<string, unknown>>
    ).discord!;
    expect(Object.keys(remainingDiscord.accounts as Record<string, unknown>)).toEqual([
      'agent-two',
    ]);
    expect(remainingDiscord.defaultAccount).toBe('agent-two');

    const deletedLast = await removeHostedChannelAccount({
      dataDir,
      channel: 'discord',
      runtimeAccountId: 'agent-two',
      deleteAccount: true,
    });
    expect((deletedLast.config.channels as Record<string, unknown>).discord).toBeUndefined();
  });

  it('rejects unsafe ids and an empty allowlist policy without writing config', async () => {
    await seedConfig({ marker: 'unchanged' });
    await expect(
      ensureHostedChannelAccount({
        dataDir,
        channel: 'discord',
        runtimeAccountId: '../escape',
        connectionId: connectionA,
        accountId: accountA,
        capabilityEpoch: 'c1',
        bindAgentId: 'agent',
        dmPolicy: 'pairing',
        allowFrom: [],
      }),
    ).rejects.toThrow(ConfigGenError);
    await expect(
      ensureHostedChannelAccount({
        dataDir,
        channel: 'telegram',
        runtimeAccountId: 'agent',
        connectionId: connectionA,
        accountId: accountA,
        capabilityEpoch: 'c1',
        bindAgentId: 'agent',
        dmPolicy: 'allowlist',
        allowFrom: [],
      }),
    ).rejects.toThrow(ConfigGenError);
    expect(await readOpenClawConfig(dataDir)).toEqual({ marker: 'unchanged' });
  });

  it('projects mention-gated allowlisted Discord and Telegram groups into native and runtime config', async () => {
    await seedConfig(hostedAgents(['discord-agent', 'telegram-agent']));
    const allowFrom = ['404322488215142410'];
    await ensureHostedChannelAccount({
      dataDir,
      channel: 'discord',
      runtimeAccountId: 'discord-agent',
      connectionId: connectionA,
      accountId: accountA,
      capabilityEpoch: 'c1',
      bindAgentId: 'discord-agent',
      dmPolicy: 'allowlist',
      allowFrom,
      discordGuilds: [
        { guildId: '111111111111111111', channelIds: ['222222222222222222'] },
      ],
    });
    const { config } = await ensureHostedChannelAccount({
      dataDir,
      channel: 'telegram',
      runtimeAccountId: 'telegram-agent',
      connectionId: connectionB,
      accountId: accountB,
      capabilityEpoch: 'c1',
      bindAgentId: 'telegram-agent',
      dmPolicy: 'allowlist',
      allowFrom,
      telegramGroups: [{ groupId: '-1001234567890' }],
    });

    const channels = config.channels as Record<string, { accounts: Record<string, Record<string, unknown>> }>;
    expect(channels.discord!.accounts['discord-agent']).toMatchObject({
      groupPolicy: 'allowlist',
      guilds: {
        '111111111111111111': {
          users: allowFrom,
          requireMention: true,
          channels: {
            '222222222222222222': {
              enabled: true,
              requireMention: true,
              users: allowFrom,
            },
          },
        },
      },
    });
    expect(channels.telegram!.accounts['telegram-agent']).toMatchObject({
      groupPolicy: 'allowlist',
      groupAllowFrom: allowFrom,
      groups: { '-1001234567890': { enabled: true, requireMention: true } },
    });
    const mappings = (
      config.plugins as { entries: Record<string, { config: { accounts: unknown[] } }> }
    ).entries[EDEN_CHANNEL_RUNTIME_PLUGIN_ID]!.config.accounts;
    expect(mappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: 'discord',
          accountId: 'discord-agent',
          groups: [{
            conversationId: '222222222222222222',
            guildId: '111111111111111111',
            allowFrom,
            mentionRequired: true,
          }],
        }),
        expect.objectContaining({
          channel: 'telegram',
          accountId: 'telegram-agent',
          groups: [{
            conversationId: '-1001234567890',
            guildId: null,
            allowFrom,
            mentionRequired: true,
          }],
        }),
      ]),
    );
  });
});
