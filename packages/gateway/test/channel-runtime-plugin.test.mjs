import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  buildHostedChannelAccountMap,
} from '../../../infra/openclaw/plugins/eden3-channel-runtime/account-map.js';
import {
  channelRuntimeBridgeInternals,
  createEdenChannelRuntimeBridge,
} from '../../../infra/openclaw/plugins/eden3-channel-runtime/bridge.js';
import {
  createDurableDeliverySuccessOutbox,
} from '../../../infra/openclaw/plugins/eden3-channel-runtime/delivery-outbox.js';
import {
  createDurablePairingCallbackOutbox,
} from '../../../infra/openclaw/plugins/eden3-channel-runtime/pairing-callback-outbox.js';
import {
  ChannelRuntimeClientError,
  createChannelRuntimeClient,
  validateChannelRuntimeBaseUrl,
} from '../../../infra/openclaw/plugins/eden3-channel-runtime/runtime-client.js';
import {
  BOT_LOOP_TTL_MS,
  createDurableBotLoopBreaker,
} from '../../../infra/openclaw/plugins/eden3-channel-runtime/loop-breaker.js';

const CONNECTION_A = '11111111-1111-4111-8111-111111111111';
const CONNECTION_B = '22222222-2222-4222-8222-222222222222';
const RUN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUN_B = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const RUN_C = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const EDEN_SESSION_A = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EDEN_SESSION_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PEER_A = '963544662646354001';
const PEER_B = '1532630091471786166';
const SESSION_A = 'agent:agent-a:discord:account-a:direct:963544662646354001';
const SESSION_B = 'agent:agent-b:discord:account-b:direct:1532630091471786166';
const TELEGRAM_SESSION_A = 'agent:agent-a:telegram:account-a:direct:963544662646354001';
const MEMORY_A = 'memory/users/alice-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.md';
const MEMORY_GROUP = `memory/users/channel-group-${'a'.repeat(64)}.md`;

function hostedConfig(overrides = {}) {
  return {
    agents: {
      defaults: {
        model: { primary: 'anthropic/claude-haiku-4-5' },
        models: {
          'anthropic/claude-sonnet-4-6': { agentRuntime: { id: 'claude-cli' } },
          'anthropic/claude-haiku-4-5': { agentRuntime: { id: 'openclaw' } },
        },
      },
      list: [
        { id: 'agent-a', model: 'anthropic/claude-sonnet-4-6' },
        { id: 'agent-b', model: 'anthropic/claude-haiku-4-5' },
      ],
    },
    channels: {
      discord: {
        enabled: true,
        accounts: {
          // config.current() exposes resolved values here. The runtime mapping
          // must not inspect either credential field.
          'account-a': { enabled: true, groupPolicy: 'disabled', token: 'resolved-value-a' },
          'account-b': { enabled: true, groupPolicy: 'disabled', token: 'resolved-value-b' },
        },
      },
    },
    bindings: [
      { agentId: 'agent-a', match: { channel: 'discord', accountId: 'account-a' } },
      { agentId: 'agent-b', match: { channel: 'discord', accountId: 'account-b' } },
    ],
    plugins: {
      entries: {
        'eden3-channel-runtime': {
          config: {
            accounts: [
              {
                channel: 'discord',
                accountId: 'account-a',
                connectionId: CONNECTION_A,
                agentId: 'agent-a',
                model: 'anthropic/claude-sonnet-4-6',
                agentRuntime: 'claude-cli',
              },
              {
                channel: 'discord',
                accountId: 'account-b',
                connectionId: CONNECTION_B,
                agentId: 'agent-b',
                model: 'anthropic/claude-haiku-4-5',
                agentRuntime: 'openclaw',
              },
            ],
          },
        },
      },
    },
    ...overrides,
  };
}

function hostedPluginConfig(config) {
  return config.plugins.entries['eden3-channel-runtime'].config;
}

function telegramHostedConfig() {
  const config = hostedConfig();
  config.channels = {
    telegram: {
      enabled: true,
      accounts: {
        'account-a': { enabled: true, groupPolicy: 'disabled', botToken: 'resolved-value-a' },
      },
    },
  };
  config.bindings = [
    { agentId: 'agent-a', match: { channel: 'telegram', accountId: 'account-a' } },
  ];
  config.plugins.entries['eden3-channel-runtime'].config.accounts = [
    {
      channel: 'telegram',
      accountId: 'account-a',
      connectionId: CONNECTION_A,
      agentId: 'agent-a',
      model: 'anthropic/claude-sonnet-4-6',
      agentRuntime: 'claude-cli',
    },
  ];
  return config;
}

function groupHostedConfig() {
  const config = hostedConfig();
  config.agents.list[0].model = 'anthropic/claude-haiku-4-5';
  config.channels.discord.accounts['account-a'].groupPolicy = 'allowlist';
  config.plugins.entries['eden3-channel-runtime'].config.accounts[0] = {
    ...config.plugins.entries['eden3-channel-runtime'].config.accounts[0],
    model: 'anthropic/claude-haiku-4-5',
    agentRuntime: 'openclaw',
    groups: [
    {
      conversationId: '758719600895590444',
      guildId: '758719600895590441',
      allowFrom: [PEER_A],
      mentionRequired: true,
    },
    ],
  };
  return config;
}

function telegramGroupHostedConfig() {
  const config = telegramHostedConfig();
  config.agents.list[0].model = 'anthropic/claude-haiku-4-5';
  config.channels.telegram.accounts['account-a'].groupPolicy = 'allowlist';
  config.plugins.entries['eden3-channel-runtime'].config.accounts[0] = {
    ...config.plugins.entries['eden3-channel-runtime'].config.accounts[0],
    model: 'anthropic/claude-haiku-4-5',
    agentRuntime: 'openclaw',
    groups: [
    {
      conversationId: '-1001234567890',
      guildId: null,
      allowFrom: [PEER_A],
      mentionRequired: true,
    },
    ],
  };
  return config;
}

function memoryDeliverySuccessOutbox() {
  const entries = new Map();
  return {
    record(marker) {
      entries.set(`${marker.connectionId}:${marker.turnId}`, structuredClone(marker));
      return marker;
    },
    list() {
      return [...entries.values()].map((marker) => structuredClone(marker));
    },
    remove(marker) {
      return entries.delete(`${marker.connectionId}:${marker.turnId}`);
    },
  };
}

function memoryPairingCallbackOutbox(initial = []) {
  const entries = new Map(
    initial.map((marker) => [
      `${marker.connectionId}\0${marker.runtimeAccountId}\0${marker.peerId}`,
      structuredClone(marker),
    ]),
  );
  return {
    record(marker) {
      const key = `${marker.connectionId}\0${marker.runtimeAccountId}\0${marker.peerId}`;
      entries.set(key, structuredClone(marker));
      return marker;
    },
    list() {
      return [...entries.values()].map((marker) => structuredClone(marker));
    },
    remove(marker) {
      const key = `${marker.connectionId}\0${marker.runtimeAccountId}\0${marker.peerId}`;
      const existing = entries.get(key);
      if (!existing) return false;
      if (existing.code !== marker.code || existing.expiresAt !== marker.expiresAt) {
        throw new Error('channel pairing callback marker conflict');
      }
      return entries.delete(key);
    },
  };
}

function mockBridge(config = hostedConfig(), handlers = {}, bridgeOptions = {}) {
  const calls = [];
  const client = {
    post: vi.fn(async (path, body, options) => {
      calls.push({ path, body: structuredClone(body), options });
      if (handlers[path]) return handlers[path](body, options);
      if (path === '/channels/runtime/messages' && body.role === 'user') {
        return {
          ok: true,
          sessionId: body.runtimeAccountId === 'account-a' ? EDEN_SESSION_A : EDEN_SESSION_B,
          memoryContext:
            body.conversationScope === 'group'
              ? { linkState: 'group', relativePath: MEMORY_GROUP }
              : { linkState: 'linked', relativePath: MEMORY_A },
        };
      }
      if (path === '/channels/runtime/turns/reserve') {
        const mapping = config.plugins.entries['eden3-channel-runtime'].config.accounts.find(
          (candidate) => candidate.accountId === body.runtimeAccountId,
        );
        return {
          ok: true,
          providerAdmitted: true,
          turnId: body.turnId,
          model: mapping.model,
          agentRuntime: mapping.agentRuntime,
          pricingBasis: mapping.agentRuntime === 'claude-cli' ? 'notional-subscription' : 'provider-api',
        };
      }
      return { ok: true };
    }),
  };
  const api = {
    pluginConfig: hostedPluginConfig(config),
    runtime: { config: { current: () => config } },
  };
  return {
    bridge: createEdenChannelRuntimeBridge({
      api,
      client,
      now: () => 1_800_000_000_000,
      deliverySuccessOutbox: memoryDeliverySuccessOutbox(),
      pairingCallbackOutbox: memoryPairingCallbackOutbox(),
      ...bridgeOptions,
    }),
    calls,
  };
}

function receiveA(bridge, overrides = {}) {
  bridge.onMessageReceived(
    {
      content: 'hello from Discord',
      timestamp: 1_800_000_000_000,
      messageId: '1532630091471786166',
      senderId: PEER_A,
      from: `discord:${PEER_A}`,
      // Identity-looking metadata is untrusted and must have no effect.
      metadata: {
        messageId: '1532630091471786166',
        connectionId: CONNECTION_B,
        runtimeAccountId: 'account-b',
        senderId: PEER_A,
      },
      ...overrides.event,
    },
    {
      channelId: 'discord',
      accountId: 'account-a',
      conversationId: '963544662646354001',
      sessionKey: SESSION_A,
      messageId: '1532630091471786166',
      senderId: PEER_A,
      ...overrides.context,
    },
  );
}

function receiveTelegramA(bridge, overrides = {}) {
  bridge.onMessageReceived(
    {
      content: 'hello from Telegram',
      timestamp: 1_800_000_000_000,
      messageId: '42',
      senderId: PEER_A,
      from: `telegram:${PEER_A}`,
      metadata: { messageId: '42', senderId: PEER_A },
      ...overrides.event,
    },
    {
      channelId: 'telegram',
      accountId: 'account-a',
      conversationId: PEER_A,
      sessionKey: TELEGRAM_SESSION_A,
      messageId: '42',
      senderId: PEER_A,
      ...overrides.context,
    },
  );
}

function receiveTelegramGroup(bridge, overrides = {}) {
  const conversationId = '-1001234567890';
  const sessionKey = `agent:agent-a:telegram:account-a:group:${conversationId}`;
  bridge.onMessageReceived(
    {
      content: 'hello from a Telegram group',
      timestamp: 1_800_000_000_000,
      messageId: '84',
      senderId: PEER_A,
      from: `telegram:group:${conversationId}`,
      metadata: { messageId: '84', senderId: PEER_A, chatType: 'group', isGroup: true },
      ...overrides.event,
    },
    {
      channelId: 'telegram',
      accountId: 'account-a',
      conversationId,
      sessionKey,
      messageId: '84',
      senderId: PEER_A,
      isGroup: true,
      wasMentioned: true,
      ...overrides.context,
    },
  );
  return { conversationId, sessionKey };
}

describe('hosted channel account mapping', () => {
  it('never reuses a connection UUID as the turn id for a legacy non-UUID run id', () => {
    const first = channelRuntimeBridgeInternals.uuidFromParts('legacy-run-one', CONNECTION_A, 'm1');
    const second = channelRuntimeBridgeInternals.uuidFromParts('legacy-run-two', CONNECTION_A, 'm2');
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toMatch(/^[0-9a-f-]{36}$/);
    expect(first).not.toBe(CONNECTION_A);
    expect(second).not.toBe(CONNECTION_A);
    expect(first).not.toBe(second);
  });

  it('derives connection identity only from validated non-secret plugin config', () => {
    const config = hostedConfig();
    const map = buildHostedChannelAccountMap(config, hostedPluginConfig(config));
    expect(map.resolve('discord', 'account-a')).toEqual({
      kind: 'valid',
      mapping: {
        channel: 'discord',
        runtimeAccountId: 'account-a',
        connectionId: CONNECTION_A,
        agentId: 'agent-a',
        model: {
          ref: 'anthropic/claude-sonnet-4-6',
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
        },
        agentRuntime: 'claude-cli',
      },
    });
    expect(map.resolve('discord', 'account-b').mapping.agentRuntime).toBe('openclaw');
    expect(map.resolve('telegram', 'account-a')).toEqual({ kind: 'not-hosted' });
  });

  it('never reads resolved token values and fails closed on duplicate mapped ownership', () => {
    const config = hostedConfig();
    config.channels.discord.accounts['account-a'] = new Proxy(
      { enabled: true, groupPolicy: 'disabled' },
      {
        get(target, property, receiver) {
          if (property === 'token' || property === 'botToken') {
            throw new Error('credential field was read');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    expect(
      buildHostedChannelAccountMap(config, hostedPluginConfig(config)).resolve(
        'discord',
        'account-a',
      ).kind,
    ).toBe('valid');

    const duplicate = hostedConfig();
    duplicate.plugins.entries['eden3-channel-runtime'].config.accounts[1].connectionId =
      CONNECTION_A;
    const map = buildHostedChannelAccountMap(duplicate, hostedPluginConfig(duplicate));
    expect(map.resolve('discord', 'account-a')).toEqual({ kind: 'invalid' });
    expect(map.resolve('discord', 'account-b')).toEqual({ kind: 'invalid' });
    expect(map.list()).toEqual([]);
  });
});

describe('OpenClaw hosted-channel lifecycle bridge', () => {
  it('preserves an authoritative provider cost for provider-reported settlement', () => {
    expect(
      channelRuntimeBridgeInternals.normalizeUsage({
        input: 3,
        output: 2,
        total: 5,
        cost: 0.0123,
      }),
    ).toEqual({
      promptTokens: 3,
      completionTokens: 2,
      totalTokens: 5,
      providerCostUsd: 0.0123,
    });
  });

  it('syncs inbound, injects canonical memory, reserves before work, settles exact usage, and mirrors output', async () => {
    const { bridge, calls } = mockBridge();
    receiveA(bridge);

    // A persisted native /model override cannot change the bound Eden model.
    expect(
      bridge.onBeforeModelResolve(
        { prompt: 'normal message after /model' },
        {
          runId: RUN_A,
          sessionKey: SESSION_A,
          messageProvider: 'discord',
          modelProviderId: 'attacker-provider',
          modelId: 'attacker-model',
        },
      ),
    ).toEqual({ providerOverride: 'anthropic', modelOverride: 'claude-sonnet-4-6' });

    const promptResult = await bridge.onBeforePromptBuild(
      { prompt: 'hello', messages: [] },
      { runId: RUN_A, sessionKey: SESSION_A, messageProvider: 'discord' },
    );
    expect(promptResult.prependSystemContext).toContain(`\`${MEMORY_A}\``);
    expect(promptResult.prependSystemContext).toContain('Identity link state: linked.');
    expect(promptResult.prependSystemContext).not.toContain(CONNECTION_A);
    expect(promptResult.prependSystemContext).not.toContain(PEER_A);
    expect(
      bridge.onBeforeToolCall(
        { toolName: 'memory_search', params: { query: 'direct context' }, runId: RUN_A },
        { runId: RUN_A, sessionKey: SESSION_A, agentId: 'agent-a' },
      ),
    ).toBeUndefined();

    await expect(
      bridge.onBeforeAgentRun(
        { accountId: 'account-a', senderId: PEER_A, prompt: 'hello', messages: [] },
        {
          runId: RUN_A,
          sessionKey: SESSION_A,
          messageProvider: 'discord',
          agentId: 'agent-a',
        },
      ),
    ).resolves.toEqual({ outcome: 'pass' });

    // llm_output is fire-and-forget and may not have been observed yet. The
    // final hook's aggregate usageState is sufficient to gate settlement.
    await expect(
      bridge.onReplyPayloadSending(
        {
          kind: 'final',
          runId: RUN_A,
          payload: { text: 'assistant answer' },
          usageState: {
            usage: { input: 17, output: 5, cacheRead: 7, cacheWrite: 2, total: 31 },
            provider: 'claude-cli',
            model: 'claude-sonnet-4-6',
            resolvedRef: 'claude-cli/claude-sonnet-4-6',
          },
        },
        {
          runId: RUN_A,
          sessionKey: SESSION_A,
          channelId: 'discord',
          accountId: 'account-a',
          messageId: '1532630091471786166',
        },
      ),
    ).resolves.toBeUndefined();

    const businessCalls = calls.filter((call) => call.path !== '/channels/runtime/status');
    expect(businessCalls.map((call) => call.path)).toEqual([
      '/channels/runtime/messages',
      '/channels/runtime/turns/reserve',
      `/channels/runtime/turns/${RUN_A}/settle`,
      '/channels/runtime/messages',
    ]);
    expect(businessCalls[1].options).toEqual({ timeoutMs: 20_000 });
    expect(businessCalls[0].body).toMatchObject({
      connectionId: CONNECTION_A,
      runtimeAccountId: 'account-a',
      conversationId: '963544662646354001',
      peerId: PEER_A,
      role: 'user',
      content: 'hello from Discord',
    });
    expect(businessCalls[1].body).toEqual({
      turnId: RUN_A,
      connectionId: CONNECTION_A,
      runtimeAccountId: 'account-a',
      agentId: 'agent-a',
      sessionId: EDEN_SESSION_A,
      externalMessageId: '1532630091471786166',
    });
    expect(businessCalls[2].body).toEqual({
      usage: {
        promptTokens: 17,
        completionTokens: 5,
        cachedTokens: 7,
        cacheWriteTokens: 2,
        totalTokens: 31,
      },
      provider: 'claude-cli',
      model: 'claude-sonnet-4-6',
      agentRuntime: 'claude-cli',
    });
    expect(businessCalls[2].options).toEqual({ timeoutMs: 20_000 });
    expect(businessCalls[3].body).toMatchObject({
      connectionId: CONNECTION_A,
      runtimeAccountId: 'account-a',
      gatewaySessionKey: SESSION_A,
      peerId: PEER_A,
      role: 'assistant',
      content: 'assistant answer',
      externalMessageId: `eden-channel-assistant:${RUN_A}`,
    });
  });

  it('keeps two bot accounts isolated and ignores caller-supplied connection metadata', async () => {
    const { bridge, calls } = mockBridge();
    receiveA(bridge);
    await bridge.onBeforeAgentRun(
      { accountId: 'account-a', senderId: PEER_A, prompt: 'hello', messages: [] },
      { runId: RUN_A, sessionKey: SESSION_A, messageProvider: 'discord', agentId: 'agent-a' },
    );
    bridge.onMessageReceived(
      {
        content: 'hello to bot B',
        messageId: '1532630091471786167',
        senderId: PEER_B,
        from: `discord:${PEER_B}`,
        metadata: {
          messageId: '1532630091471786167',
          connectionId: CONNECTION_A,
          runtimeAccountId: 'account-a',
          senderId: PEER_B,
        },
      },
      {
        channelId: 'discord',
        accountId: 'account-b',
        conversationId: PEER_B,
        sessionKey: SESSION_B,
        messageId: '1532630091471786167',
        senderId: PEER_B,
      },
    );
    await bridge.onBeforeAgentRun(
      { accountId: 'account-b', senderId: PEER_B, prompt: 'hello', messages: [] },
      { runId: RUN_B, sessionKey: SESSION_B, messageProvider: 'discord', agentId: 'agent-b' },
    );
    const userSyncs = calls.filter(
      (call) => call.path === '/channels/runtime/messages' && call.body.role === 'user',
    );
    expect(userSyncs.map((call) => [call.body.runtimeAccountId, call.body.connectionId])).toEqual([
      ['account-a', CONNECTION_A],
      ['account-b', CONNECTION_B],
    ]);
    expect(
      calls
        .filter((call) => call.path === '/channels/runtime/turns/reserve')
        .map((call) => [call.body.runtimeAccountId, call.body.sessionId]),
    ).toEqual([
      ['account-a', EDEN_SESSION_A],
      ['account-b', EDEN_SESSION_B],
    ]);
  });

  it('FG-CHANNEL-RUNTIME-QUEUE accepts runless inbound state but executes one session turn at a time', async () => {
    const { bridge, calls } = mockBridge();
    receiveA(bridge);
    receiveA(bridge, {
      event: {
        content: 'second queued message',
        messageId: '1532630091471786168',
        metadata: { messageId: '1532630091471786168', senderId: PEER_A },
      },
      context: { messageId: '1532630091471786168' },
    });

    await bridge.onBeforeAgentRun(
      { accountId: 'account-a', senderId: PEER_A, prompt: 'first', messages: [] },
      { runId: RUN_A, sessionKey: SESSION_A, messageProvider: 'discord', agentId: 'agent-a' },
    );
    const secondRun = bridge.onBeforeAgentRun(
      { accountId: 'account-a', senderId: PEER_A, prompt: 'second', messages: [] },
      { runId: RUN_B, sessionKey: SESSION_A, messageProvider: 'discord', agentId: 'agent-a' },
    );
    await Promise.resolve();
    expect(calls.filter((call) => call.path === '/channels/runtime/turns/reserve')).toHaveLength(1);
    await bridge.onAgentEnd(
      { runId: RUN_A, success: false, messages: [] },
      { runId: RUN_A, sessionKey: SESSION_A },
    );
    await secondRun;

    expect(
      calls
        .filter((call) => call.path === '/channels/runtime/turns/reserve')
        .map((call) => [call.body.turnId, call.body.externalMessageId]),
    ).toEqual([
      [RUN_A, '1532630091471786166'],
      [RUN_B, '1532630091471786168'],
    ]);
  });

  it('gives a queued turn a fresh full correlation lease when its provider run starts', async () => {
    vi.useFakeTimers();
    try {
      const { bridge, calls } = mockBridge();
      receiveA(bridge);
      receiveA(bridge, {
        event: {
          content: 'second queued message',
          messageId: '1532630091471786168',
          metadata: { messageId: '1532630091471786168', senderId: PEER_A },
        },
        context: { messageId: '1532630091471786168' },
      });

      await bridge.onBeforeAgentRun(
        { accountId: 'account-a', senderId: PEER_A, prompt: 'first', messages: [] },
        { runId: RUN_A, sessionKey: SESSION_A, messageProvider: 'discord', agentId: 'agent-a' },
      );
      await vi.advanceTimersByTimeAsync(30 * 60 * 1_000 + 30_000);
      const secondRun = bridge.onBeforeAgentRun(
        { accountId: 'account-a', senderId: PEER_A, prompt: 'second', messages: [] },
        { runId: RUN_B, sessionKey: SESSION_A, messageProvider: 'discord', agentId: 'agent-a' },
      );
      await Promise.resolve();
      expect(
        calls.some((call) => call.path === '/channels/runtime/turns/reserve' && call.body.turnId === RUN_B),
      ).toBe(false);
      await bridge.onAgentEnd(
        { runId: RUN_A, success: false, messages: [] },
        { runId: RUN_A, sessionKey: SESSION_A },
      );
      await secondRun;

      // The original inbound timer would expire five minutes into this run.
      // Advance through an entire valid provider ceiling from B's actual
      // claim: B must remain reserved and exactly correlatable.
      await vi.advanceTimersByTimeAsync(30 * 60 * 1_000 + 30_000);
      expect(
        calls.some((call) => call.path === `/channels/runtime/turns/${RUN_B}/refund`),
      ).toBe(false);
      await expect(
        bridge.onReplyPayloadSending(
          {
            kind: 'final',
            runId: RUN_B,
            payload: { text: 'second answer' },
            usageState: {
              usage: { input: 3, output: 2, total: 5 },
              provider: 'claude-cli',
              model: 'claude-sonnet-4-6',
            },
          },
          {
            runId: RUN_B,
            sessionKey: SESSION_A,
            channelId: 'discord',
            accountId: 'account-a',
            messageId: '1532630091471786168',
          },
        ),
      ).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a protected reply whose run or inbound message identity drifts', async () => {
    const wrongRun = mockBridge();
    receiveA(wrongRun.bridge);
    await wrongRun.bridge.onBeforeAgentRun(
      { accountId: 'account-a', senderId: PEER_A, prompt: 'hello', messages: [] },
      { runId: RUN_A, sessionKey: SESSION_A, messageProvider: 'discord', agentId: 'agent-a' },
    );
    await expect(
      wrongRun.bridge.onReplyPayloadSending(
        { kind: 'final', runId: RUN_B, payload: { text: 'must not send' } },
        {
          runId: RUN_B,
          sessionKey: SESSION_A,
          channelId: 'discord',
          accountId: 'account-a',
          messageId: '1532630091471786166',
        },
      ),
    ).resolves.toEqual({
      cancel: true,
      reason: 'Eden channel turn correlation unavailable',
    });

    const wrongMessage = mockBridge();
    receiveA(wrongMessage.bridge);
    await wrongMessage.bridge.onBeforeAgentRun(
      { accountId: 'account-a', senderId: PEER_A, prompt: 'hello', messages: [] },
      { runId: RUN_A, sessionKey: SESSION_A, messageProvider: 'discord', agentId: 'agent-a' },
    );
    await expect(
      wrongMessage.bridge.onReplyPayloadSending(
        { kind: 'final', runId: RUN_A, payload: { text: 'must not send' } },
        {
          runId: RUN_A,
          sessionKey: SESSION_A,
          channelId: 'discord',
          accountId: 'account-a',
          messageId: '1532630091471786999',
        },
      ),
    ).resolves.toEqual({ cancel: true, reason: 'Eden channel identity mismatch' });
    expect(
      wrongMessage.calls.some(
        (call) => call.path === `/channels/runtime/turns/${RUN_A}/refund`,
      ),
    ).toBe(true);

    const missingMessage = mockBridge();
    receiveA(missingMessage.bridge);
    await missingMessage.bridge.onBeforeAgentRun(
      { accountId: 'account-a', senderId: PEER_A, prompt: 'hello', messages: [] },
      { runId: RUN_A, sessionKey: SESSION_A, messageProvider: 'discord', agentId: 'agent-a' },
    );
    await expect(
      missingMessage.bridge.onReplyPayloadSending(
        { kind: 'final', runId: RUN_A, payload: { text: 'must not send' } },
        {
          runId: RUN_A,
          sessionKey: SESSION_A,
          channelId: 'discord',
          accountId: 'account-a',
        },
      ),
    ).resolves.toEqual({ cancel: true, reason: 'Eden channel identity mismatch' });
    expect(
      missingMessage.calls.some(
        (call) => call.path === `/channels/runtime/turns/${RUN_A}/refund`,
      ),
    ).toBe(true);
  });

  it('blocks group transcripts before memory, provider work, or outward delivery', async () => {
    const { bridge, calls } = mockBridge();
    const groupSession = 'agent:agent-a:discord:channel:758719600895590444';
    bridge.onMessageReceived(
      {
        content: 'group message',
        messageId: '1532630091471786199',
        senderId: PEER_A,
        from: 'discord:channel:758719600895590444',
        metadata: {
          messageId: '1532630091471786199',
          chatType: 'channel',
          guildId: '758719600895590441',
          senderId: PEER_A,
        },
      },
      {
        channelId: 'discord',
        accountId: 'account-a',
        conversationId: '758719600895590444',
        sessionKey: groupSession,
        messageId: '1532630091471786199',
        senderId: PEER_A,
      },
    );

    await expect(
      bridge.onBeforePromptBuild(
        { prompt: 'group message', messages: [] },
        { runId: RUN_A, sessionKey: groupSession, messageProvider: 'discord' },
      ),
    ).resolves.toBeUndefined();
    await expect(
      bridge.onBeforeAgentRun(
        { accountId: 'account-a', senderId: PEER_A, prompt: 'group message', messages: [] },
        { runId: RUN_A, sessionKey: groupSession, messageProvider: 'discord', agentId: 'agent-a' },
      ),
    ).resolves.toMatchObject({ outcome: 'block', category: 'policy' });
    await expect(
      bridge.onReplyPayloadSending(
        { kind: 'final', runId: RUN_A, payload: { text: 'must not enter group' } },
        {
          runId: RUN_A,
          sessionKey: groupSession,
          channelId: 'discord',
          accountId: 'account-a',
        },
      ),
    ).resolves.toEqual({
      cancel: true,
      reason: 'Eden hosted group delivery is disabled',
    });
    expect(calls.some((call) => call.path === '/channels/runtime/messages')).toBe(false);
    expect(calls.some((call) => call.path.includes('/turns/'))).toBe(false);
  });

  it('FG-CHANNEL-RUNTIME-MIME rejects an unallowlisted attachment before sync, reserve, or provider execution', async () => {
    const { bridge, calls } = mockBridge();
    receiveA(bridge, {
      event: {
        attachments: [{ contentType: 'application/x-sh', name: 'payload.sh' }],
      },
    });
    await expect(
      bridge.onBeforeAgentRun(
        { accountId: 'account-a', senderId: PEER_A, prompt: 'open it', messages: [] },
        { runId: RUN_A, sessionKey: SESSION_A, messageProvider: 'discord', agentId: 'agent-a' },
      ),
    ).resolves.toMatchObject({ outcome: 'block', category: 'policy' });
    expect(calls.some((call) => call.path === '/channels/runtime/messages')).toBe(false);
    expect(calls.some((call) => call.path.endsWith('/reserve'))).toBe(false);

    const contextAttachment = mockBridge();
    receiveA(contextAttachment.bridge, {
      context: {
        attachments: [{ mimeType: 'application/x-msdownload', name: 'payload.exe' }],
      },
    });
    await expect(
      contextAttachment.bridge.onBeforeAgentRun(
        { accountId: 'account-a', senderId: PEER_A, prompt: 'open it', messages: [] },
        { runId: RUN_A, sessionKey: SESSION_A, messageProvider: 'discord', agentId: 'agent-a' },
      ),
    ).resolves.toMatchObject({ outcome: 'block', category: 'policy' });
    expect(
      contextAttachment.calls.some((call) => call.path === '/channels/runtime/messages'),
    ).toBe(false);
    expect(
      contextAttachment.calls.some((call) => call.path.endsWith('/reserve')),
    ).toBe(false);

    const mixedMedia = mockBridge();
    receiveA(mixedMedia.bridge, {
      event: {
        metadata: {
          mediaUrls: ['https://provider.invalid/safe.png', 'https://provider.invalid/payload.sh'],
          mediaPaths: ['/staged/safe.png', '/staged/payload.sh'],
          mediaTypes: ['image/png', 'application/x-sh'],
          mediaUrl: 'https://provider.invalid/safe.png',
          mediaType: 'image/png',
        },
      },
    });
    await expect(
      mixedMedia.bridge.onBeforeAgentRun(
        { accountId: 'account-a', senderId: PEER_A, prompt: 'open both', messages: [] },
        { runId: RUN_A, sessionKey: SESSION_A, messageProvider: 'discord', agentId: 'agent-a' },
      ),
    ).resolves.toMatchObject({ outcome: 'block', category: 'policy' });
    expect(mixedMedia.calls.some((call) => call.path === '/channels/runtime/messages')).toBe(false);
    expect(mixedMedia.calls.some((call) => call.path.endsWith('/reserve'))).toBe(false);

    const allowed = mockBridge();
    receiveA(allowed.bridge, {
      event: { attachments: [{ contentType: 'image/png', name: 'safe.png' }] },
    });
    await expect(
      allowed.bridge.onBeforeAgentRun(
        { accountId: 'account-a', senderId: PEER_A, prompt: 'describe it', messages: [] },
        { runId: RUN_A, sessionKey: SESSION_A, messageProvider: 'discord', agentId: 'agent-a' },
      ),
    ).resolves.toEqual({ outcome: 'pass' });
  });

  it('FG-F7 gives one allowlisted mentioned bot message a reply, then suppresses across restart and releases after TTL', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'eden3-loop-'));
    const filePath = join(tempDir, 'loop-state.json');
    let clock = 1_800_000_000_000;
    const groupSession = 'agent:agent-a:discord:channel:758719600895590444';
    const receiveGroup = (bridge, messageId) =>
      bridge.onMessageReceived(
        {
          content: 'bot-authored group message',
          messageId,
          senderId: PEER_A,
          senderIsBot: true,
          from: 'discord:channel:758719600895590444',
          metadata: {
            messageId,
            chatType: 'channel',
            guildId: '758719600895590441',
            senderId: PEER_A,
            senderIsBot: true,
            wasMentioned: true,
          },
        },
        {
          channelId: 'discord',
          accountId: 'account-a',
          conversationId: '758719600895590444',
          guildId: '758719600895590441',
          sessionKey: groupSession,
          messageId,
          senderId: PEER_A,
          senderIsBot: true,
          wasMentioned: true,
        },
      );
    try {
      const first = mockBridge(groupHostedConfig(), {}, {
        now: () => clock,
        loopBreaker: createDurableBotLoopBreaker({ filePath, now: () => clock }),
      });
      receiveGroup(first.bridge, '1532630091471786201');
      await expect(
        first.bridge.onBeforePromptBuild(
          { prompt: 'group message', messages: [] },
          { runId: RUN_A, sessionKey: groupSession, messageProvider: 'discord' },
        ),
      ).resolves.toEqual({
        systemPrompt: expect.stringContaining('never read or write any participant private-memory file'),
        toolsAllow: [],
      });
      await expect(
        first.bridge.onBeforeAgentRun(
          { accountId: 'account-a', senderId: PEER_A, prompt: 'group message', messages: [] },
          { runId: RUN_A, sessionKey: groupSession, messageProvider: 'discord', agentId: 'agent-a' },
        ),
      ).resolves.toEqual({ outcome: 'pass' });
      for (const toolName of ['memory_search', 'memory_get', 'read', 'write', 'exec']) {
        expect(
          first.bridge.onBeforeToolCall(
            { toolName, params: { path: MEMORY_A }, runId: RUN_A },
            { runId: RUN_A, sessionKey: groupSession, agentId: 'agent-a' },
          ),
        ).toEqual({
          block: true,
          blockReason: 'Hosted channel group turns cannot invoke tools.',
        });
      }
      expect(first.calls.find((call) => call.path === '/channels/runtime/messages').body).toMatchObject({
        conversationId: '758719600895590444',
        conversationScope: 'group',
        guildId: '758719600895590441',
      });
      await first.bridge.onAgentEnd(
        { runId: RUN_A, success: false, messages: [] },
        { runId: RUN_A, sessionKey: groupSession },
      );

      const restarted = mockBridge(groupHostedConfig(), {}, {
        now: () => clock,
        loopBreaker: createDurableBotLoopBreaker({ filePath, now: () => clock }),
      });
      receiveGroup(restarted.bridge, '1532630091471786202');
      await expect(
        restarted.bridge.onBeforeAgentRun(
          { accountId: 'account-a', senderId: PEER_A, prompt: 'loop', messages: [] },
          { runId: RUN_B, sessionKey: groupSession, messageProvider: 'discord', agentId: 'agent-a' },
        ),
      ).resolves.toMatchObject({ outcome: 'block' });
      expect(restarted.calls.some((call) => call.path.endsWith('/reserve'))).toBe(false);

      clock += BOT_LOOP_TTL_MS + 1;
      const expired = mockBridge(groupHostedConfig(), {}, {
        now: () => clock,
        loopBreaker: createDurableBotLoopBreaker({ filePath, now: () => clock }),
      });
      receiveGroup(expired.bridge, '1532630091471786203');
      await expect(
        expired.bridge.onBeforeAgentRun(
          { accountId: 'account-a', senderId: PEER_A, prompt: 'new window', messages: [] },
          { runId: RUN_C, sessionKey: groupSession, messageProvider: 'discord', agentId: 'agent-a' },
        ),
      ).resolves.toEqual({ outcome: 'pass' });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('admits the canonical 7.1 Discord group hook with a routed conversation target', async () => {
    const current = mockBridge(groupHostedConfig());
    const groupSession = 'agent:agent-a:discord:channel:758719600895590444';
    current.bridge.onMessageReceived(
      {
        content: 'mentioned group message',
        messageId: '1532630091471786200',
        senderId: PEER_A,
        from: 'discord:channel:758719600895590444',
        metadata: {
          guildId: '758719600895590441',
          senderId: PEER_A,
          wasMentioned: true,
        },
      },
      {
        channelId: 'discord',
        accountId: 'account-a',
        conversationId: 'channel:758719600895590444',
        sessionKey: groupSession,
        messageId: '1532630091471786200',
        senderId: PEER_A,
      },
    );

    await expect(
      current.bridge.onBeforeAgentRun(
        { accountId: 'account-a', senderId: PEER_A, prompt: 'mentioned group message', messages: [] },
        { runId: RUN_A, sessionKey: groupSession, messageProvider: 'discord', agentId: 'agent-a' },
      ),
    ).resolves.toEqual({ outcome: 'pass' });
  });

  it('admits the canonical 7.1 Telegram group hook with a provider-routed target', async () => {
    const current = mockBridge(telegramGroupHostedConfig());
    const conversationId = '-1001234567890';
    const groupSession = `agent:agent-a:telegram:group:${conversationId}`;
    current.bridge.onMessageReceived(
      {
        content: 'mentioned Telegram group message',
        messageId: '85',
        senderId: PEER_A,
        from: `telegram:group:${conversationId}`,
        metadata: { senderId: PEER_A, wasMentioned: true },
      },
      {
        channelId: 'telegram',
        accountId: 'account-a',
        conversationId: `telegram:group:${conversationId}`,
        sessionKey: groupSession,
        messageId: '85',
        senderId: PEER_A,
      },
    );

    await expect(
      current.bridge.onBeforeAgentRun(
        {
          accountId: 'account-a',
          senderId: PEER_A,
          prompt: 'mentioned Telegram group message',
          messages: [],
        },
        { runId: RUN_A, sessionKey: groupSession, messageProvider: 'telegram', agentId: 'agent-a' },
      ),
    ).resolves.toEqual({ outcome: 'pass' });
  });

  it('durably commits bot-loop suppression before admitting a bot-authored turn', () => {
    const operations = [];
    const stored = new Map();
    let nextDescriptor = 10;
    const io = {
      readFileSync(path) {
        const body = stored.get(path);
        if (body === undefined) {
          const error = new Error('missing');
          error.code = 'ENOENT';
          throw error;
        }
        return body;
      },
      mkdirSync(path) {
        operations.push(['mkdir', path]);
      },
      openSync(path, flags) {
        operations.push(['open', path, flags]);
        return nextDescriptor++;
      },
      writeFileSync(descriptor, body) {
        operations.push(['write', descriptor]);
        stored.set('pending', body);
      },
      fsyncSync(descriptor) {
        operations.push(['fsync', descriptor]);
      },
      closeSync(descriptor) {
        operations.push(['close', descriptor]);
      },
      renameSync(from, to) {
        operations.push(['rename', from, to]);
        stored.set(to, stored.get('pending'));
      },
      unlinkSync(path) {
        operations.push(['unlink', path]);
      },
    };
    const breaker = createDurableBotLoopBreaker({
      filePath: '/runtime/channel-loop.json',
      io,
      now: () => 1_800_000_000_000,
    });

    expect(breaker.admitBot(CONNECTION_A, 'discord-group-a')).toBe(true);
    const fileFsync = operations.findIndex(([kind, descriptor]) => kind === 'fsync' && descriptor === 10);
    const rename = operations.findIndex(([kind]) => kind === 'rename');
    const directoryFsync = operations.findIndex(
      ([kind, descriptor]) => kind === 'fsync' && descriptor === 11,
    );
    expect(fileFsync).toBeGreaterThanOrEqual(0);
    expect(rename).toBeGreaterThan(fileFsync);
    expect(directoryFsync).toBeGreaterThan(rename);

    const restarted = createDurableBotLoopBreaker({
      filePath: '/runtime/channel-loop.json',
      io,
      now: () => 1_800_000_000_001,
    });
    expect(restarted.admitBot(CONNECTION_A, 'discord-group-a')).toBe(false);
  });

  it('fails bot-authored turns closed when loop-state durability cannot be established', () => {
    let writes = 0;
    const io = {
      readFileSync() {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      },
      mkdirSync() {},
      openSync(path, flags) {
        if (flags === 'r') return 11;
        return 10;
      },
      writeFileSync() {
        writes += 1;
      },
      fsyncSync(descriptor) {
        if (descriptor === 10) throw new Error('disk failure');
      },
      closeSync() {},
      renameSync() {
        throw new Error('rename must not run after file fsync failure');
      },
      unlinkSync() {},
    };
    const breaker = createDurableBotLoopBreaker({
      filePath: '/runtime/channel-loop.json',
      io,
      now: () => 1_800_000_000_000,
    });

    expect(breaker.admitBot(CONNECTION_A, 'discord-group-a')).toBe(false);
    expect(writes).toBe(1);
    expect(breaker.admitBot(CONNECTION_A, 'discord-group-b')).toBe(false);
    expect(writes).toBe(1);
  });

  it('fails a group turn closed when its agent uses a runtime without turn-scoped tool narrowing', async () => {
    const config = groupHostedConfig();
    config.agents.list[0].model = 'anthropic/claude-sonnet-4-6';
    config.plugins.entries['eden3-channel-runtime'].config.accounts[0].model =
      'anthropic/claude-sonnet-4-6';
    config.plugins.entries['eden3-channel-runtime'].config.accounts[0].agentRuntime = 'claude-cli';
    const current = mockBridge(config);
    const groupSession = 'agent:agent-a:discord:channel:758719600895590444';
    current.bridge.onMessageReceived(
      {
        content: 'group message',
        messageId: '1532630091471786299',
        senderId: PEER_A,
        from: 'discord:channel:758719600895590444',
        metadata: {
          chatType: 'channel',
          guildId: '758719600895590441',
          senderId: PEER_A,
          wasMentioned: true,
        },
      },
      {
        channelId: 'discord',
        accountId: 'account-a',
        conversationId: '758719600895590444',
        guildId: '758719600895590441',
        sessionKey: groupSession,
        messageId: '1532630091471786299',
        senderId: PEER_A,
        wasMentioned: true,
      },
    );
    await expect(
      current.bridge.onBeforeAgentRun(
        { accountId: 'account-a', senderId: PEER_A, prompt: 'group message', messages: [] },
        { runId: RUN_A, sessionKey: groupSession, messageProvider: 'discord', agentId: 'agent-a' },
      ),
    ).resolves.toMatchObject({ outcome: 'block', category: 'policy' });
    expect(current.calls.some((call) => call.path.endsWith('/reserve'))).toBe(false);
  });

  it('blocks malformed hosted mappings or missing inbound sync before provider work', async () => {
    const duplicate = hostedConfig();
    duplicate.plugins.entries['eden3-channel-runtime'].config.accounts[1].connectionId =
      CONNECTION_A;
    const { bridge, calls } = mockBridge(duplicate);
    receiveA(bridge);
    const result = await bridge.onBeforeAgentRun(
      { accountId: 'account-a', senderId: PEER_A, prompt: 'hello', messages: [] },
      { runId: RUN_A, sessionKey: SESSION_A, messageProvider: 'discord', agentId: 'agent-a' },
    );
    expect(result).toMatchObject({ outcome: 'block', category: 'policy' });
    expect(calls.some((call) => call.path.includes('/turns/reserve'))).toBe(false);
  });

  it('FG-CHANNEL-RUNTIME-AUTHZ refuses an unsupported channel model before agent/provider execution', async () => {
    const config = hostedConfig();
    config.agents.list[0].model = 'openrouter/unsupported-model';
    config.agents.defaults.models['openrouter/unsupported-model'] = {
      agentRuntime: { id: 'openclaw' },
    };
    Object.assign(config.plugins.entries['eden3-channel-runtime'].config.accounts[0], {
      model: 'openrouter/unsupported-model',
      agentRuntime: 'openclaw',
    });
    const { bridge, calls } = mockBridge(config, {
      '/channels/runtime/turns/reserve': async () => {
        throw new ChannelRuntimeClientError('unsupported_channel_model', 422);
      },
    });
    receiveA(bridge);
    expect(
      bridge.onBeforeModelResolve(
        { prompt: 'try unsupported route' },
        { runId: RUN_A, sessionKey: SESSION_A, messageProvider: 'discord' },
      ),
    ).toEqual({ providerOverride: 'openrouter', modelOverride: 'unsupported-model' });
    await expect(
      bridge.onBeforeAgentRun(
        { accountId: 'account-a', senderId: PEER_A, prompt: 'try it', messages: [] },
        { runId: RUN_A, sessionKey: SESSION_A, messageProvider: 'discord', agentId: 'agent-a' },
      ),
    ).resolves.toMatchObject({ outcome: 'block', category: 'policy' });
    expect(calls.filter((call) => call.path.endsWith('/reserve'))).toHaveLength(1);
    expect(calls.some((call) => call.path.includes('/settle'))).toBe(false);
  });

  it('rejects invalid session identity or reserve provenance and refunds a claimed turn', async () => {
    const invalidSession = mockBridge(hostedConfig(), {
      '/channels/runtime/messages': async () => ({
        ok: true,
        sessionId: 'not-a-uuid',
        memoryContext: { linkState: 'linked', relativePath: MEMORY_A },
      }),
    });
    receiveA(invalidSession.bridge);
    await expect(
      invalidSession.bridge.onBeforeAgentRun(
        { accountId: 'account-a', senderId: PEER_A, prompt: 'hello', messages: [] },
        { runId: RUN_A, sessionKey: SESSION_A, messageProvider: 'discord', agentId: 'agent-a' },
      ),
    ).resolves.toMatchObject({ outcome: 'block' });
    expect(invalidSession.calls.some((call) => call.path.endsWith('/reserve'))).toBe(false);

    const drifted = mockBridge(hostedConfig(), {
      '/channels/runtime/turns/reserve': async (body) => ({
        ok: true,
        providerAdmitted: true,
        turnId: body.turnId,
        model: 'openai/gpt-5.5',
        agentRuntime: 'openclaw',
        pricingBasis: 'provider-api',
      }),
    });
    receiveA(drifted.bridge);
    await expect(
      drifted.bridge.onBeforeAgentRun(
        { accountId: 'account-a', senderId: PEER_A, prompt: 'hello', messages: [] },
        { runId: RUN_A, sessionKey: SESSION_A, messageProvider: 'discord', agentId: 'agent-a' },
      ),
    ).resolves.toMatchObject({ outcome: 'block' });
    expect(drifted.calls.some((call) => call.path.endsWith(`/${RUN_A}/refund`))).toBe(true);
    await expect(
      drifted.bridge.onReplyPayloadSending(
        {
          kind: 'final',
          runId: RUN_A,
          payload: { text: 'This channel turn could not be started.' },
        },
        {
          runId: RUN_A,
          sessionKey: SESSION_A,
          channelId: 'discord',
          accountId: 'account-a',
          messageId: '1532630091471786166',
        },
      ),
    ).resolves.toBeUndefined();
  });

  it('refunds provider failures and cancels output when settlement fails', async () => {
    const { bridge, calls } = mockBridge(hostedConfig(), {
      [`/channels/runtime/turns/${RUN_A}/settle`]: async () => {
        throw new Error('private upstream detail');
      },
    });
    receiveA(bridge);
    await bridge.onBeforeAgentRun(
      { accountId: 'account-a', senderId: PEER_A, prompt: 'hello', messages: [] },
      { runId: RUN_A, sessionKey: SESSION_A, messageProvider: 'discord', agentId: 'agent-a' },
    );
    bridge.onLlmOutput(
      {
        runId: RUN_A,
        provider: 'claude-cli',
        model: 'claude-sonnet-4-6',
        resolvedRef: 'claude-cli/claude-sonnet-4-6',
        usage: { input: 1, output: 1, total: 2 },
      },
      { runId: RUN_A },
    );
    const result = await bridge.onReplyPayloadSending(
      { kind: 'final', runId: RUN_A, payload: { text: 'must not send' } },
      {
        runId: RUN_A,
        sessionKey: SESSION_A,
        channelId: 'discord',
        accountId: 'account-a',
        messageId: '1532630091471786166',
      },
    );
    expect(result).toEqual({ cancel: true, reason: 'Eden channel settlement failed' });
    expect(calls.some((call) => call.path === `/channels/runtime/turns/${RUN_A}/refund`)).toBe(true);
    expect(calls.some((call) => call.body?.role === 'assistant')).toBe(false);
    await expect(
      bridge.onReplyPayloadSending(
        { kind: 'final', runId: RUN_A, payload: { text: 'retry must not send' } },
        {
          runId: RUN_A,
          sessionKey: SESSION_A,
          channelId: 'discord',
          accountId: 'account-a',
          messageId: '1532630091471786166',
        },
      ),
    ).resolves.toEqual({ cancel: true, reason: 'Eden channel delivery is blocked' });

    const second = mockBridge();
    receiveA(second.bridge);
    await second.bridge.onBeforeAgentRun(
      { accountId: 'account-a', senderId: PEER_A, prompt: 'hello', messages: [] },
      { runId: RUN_A, sessionKey: SESSION_A, messageProvider: 'discord', agentId: 'agent-a' },
    );
    await second.bridge.onAgentEnd(
      { runId: RUN_A, success: false, messages: [], error: 'provider private detail' },
      { runId: RUN_A, sessionKey: SESSION_A },
    );
    expect(
      second.calls.some((call) => call.path === `/channels/runtime/turns/${RUN_A}/refund`),
    ).toBe(true);
    await expect(
      second.bridge.onReplyPayloadSending(
        {
          kind: 'final',
          runId: RUN_A,
          payload: { text: 'The provider failed. Please try again.', isError: true },
        },
        {
          runId: RUN_A,
          sessionKey: SESSION_A,
          channelId: 'discord',
          accountId: 'account-a',
          messageId: '1532630091471786166',
        },
      ),
    ).resolves.toBeUndefined();
  });

  it('compensates a settled turn when assistant sync fails before delivery', async () => {
    const { bridge, calls } = mockBridge(hostedConfig(), {
      '/channels/runtime/messages': async (body) => {
        if (body.role === 'user') {
          return {
            ok: true,
            sessionId: EDEN_SESSION_A,
            memoryContext: { linkState: 'linked', relativePath: MEMORY_A },
          };
        }
        throw new Error('database unavailable');
      },
    });
    receiveA(bridge);
    await bridge.onBeforeAgentRun(
      { accountId: 'account-a', senderId: PEER_A, prompt: 'hello', messages: [] },
      { runId: RUN_A, sessionKey: SESSION_A, messageProvider: 'discord', agentId: 'agent-a' },
    );

    await expect(
      bridge.onReplyPayloadSending(
        {
          kind: 'final',
          runId: RUN_A,
          payload: { text: 'must not escape without sync' },
          usageState: {
            usage: { input: 3, output: 2, total: 5 },
            provider: 'claude-cli',
            model: 'claude-sonnet-4-6',
            resolvedRef: 'claude-cli/claude-sonnet-4-6',
          },
        },
        {
          runId: RUN_A,
          sessionKey: SESSION_A,
          channelId: 'discord',
          accountId: 'account-a',
          messageId: '1532630091471786166',
        },
      ),
    ).resolves.toEqual({
      cancel: true,
      reason: 'Eden channel assistant synchronization failed',
    });
    expect(
      calls.some((call) => call.path === `/channels/runtime/turns/${RUN_A}/settle`),
    ).toBe(true);
    expect(
      calls.some(
        (call) => call.path === `/channels/runtime/turns/${RUN_A}/delivery-failed`,
      ),
    ).toBe(true);
  });

  it('compensates the exact host-propagated Telegram run on delivery failure', async () => {
    const { bridge, calls } = mockBridge(telegramHostedConfig());
    receiveTelegramA(bridge);
    await bridge.onBeforeAgentRun(
      { accountId: 'account-a', senderId: PEER_A, prompt: 'hello', messages: [] },
      {
        runId: RUN_A,
        sessionKey: TELEGRAM_SESSION_A,
        messageProvider: 'telegram',
        agentId: 'agent-a',
      },
    );
    await expect(
      bridge.onReplyPayloadSending(
        {
          kind: 'final',
          runId: RUN_A,
          payload: { text: 'assistant answer' },
          usageState: {
            usage: { input: 3, output: 2, total: 5 },
            provider: 'claude-cli',
            model: 'claude-sonnet-4-6',
            resolvedRef: 'claude-cli/claude-sonnet-4-6',
          },
        },
        {
          runId: RUN_A,
          sessionKey: TELEGRAM_SESSION_A,
          channelId: 'telegram',
          accountId: 'account-a',
          messageId: '42',
        },
      ),
    ).resolves.toBeUndefined();

    // Eden's pinned host patch propagates reply_payload_sending.runId through
    // the otherwise runless Telegram delivery path into message_sent.
    bridge.onMessageSent(
      {
        to: PEER_A,
        content: 'assistant answer',
        runId: RUN_A,
        success: false,
        error: 'network timeout',
      },
      {
        channelId: 'telegram',
        accountId: 'account-a',
        conversationId: PEER_A,
        runId: RUN_A,
      },
    );

    await vi.waitFor(() =>
      expect(
        calls.some(
          (call) => call.path === `/channels/runtime/turns/${RUN_A}/delivery-failed`,
        ),
      ).toBe(true),
    );
  });

  it('accepts Telegram numeric sender ids while preserving exact peer identity', async () => {
    const { bridge, calls } = mockBridge(telegramHostedConfig());
    const peerId = '857837419';
    const numericPeerId = 857837419;
    const sessionKey = `agent:agent-a:telegram:account-a:direct:${peerId}`;
    receiveTelegramA(bridge, {
      event: {
        senderId: numericPeerId,
        from: `telegram:${peerId}`,
        metadata: { messageId: '42', senderId: numericPeerId },
      },
      context: {
        senderId: numericPeerId,
        conversationId: peerId,
        sessionKey,
      },
    });

    await expect(
      bridge.onBeforeAgentRun(
        { accountId: 'account-a', senderId: numericPeerId, prompt: 'hello', messages: [] },
        {
          runId: RUN_A,
          sessionKey,
          messageProvider: 'telegram',
          agentId: 'agent-a',
        },
      ),
    ).resolves.toEqual({ outcome: 'pass' });
    expect(calls.some((call) => call.path === '/channels/runtime/turns/reserve')).toBe(true);
  });

  it('durably acknowledges the exact successful native delivery', async () => {
    const { bridge, calls } = mockBridge(telegramHostedConfig());
    receiveTelegramA(bridge);
    await bridge.onBeforeAgentRun(
      { accountId: 'account-a', senderId: PEER_A, prompt: 'hello', messages: [] },
      {
        runId: RUN_A,
        sessionKey: TELEGRAM_SESSION_A,
        messageProvider: 'telegram',
        agentId: 'agent-a',
      },
    );
    await bridge.onReplyPayloadSending(
      {
        kind: 'final',
        runId: RUN_A,
        payload: { text: 'assistant answer' },
        usageState: {
          usage: { input: 3, output: 2, total: 5 },
          provider: 'claude-cli',
          model: 'claude-sonnet-4-6',
        },
      },
      {
        runId: RUN_A,
        sessionKey: TELEGRAM_SESSION_A,
        channelId: 'telegram',
        accountId: 'account-a',
        messageId: '42',
      },
    );

    await bridge.onMessageSent(
      { to: PEER_A, content: 'assistant answer', runId: RUN_A, success: true },
      {
        channelId: 'telegram',
        accountId: 'account-a',
        conversationId: PEER_A,
        runId: RUN_A,
      },
    );

    expect(
      calls.some((call) => call.path === `/channels/runtime/turns/${RUN_A}/delivered`),
    ).toBe(true);
    expect(
      calls.some((call) => call.path === `/channels/runtime/turns/${RUN_A}/delivery-failed`),
    ).toBe(false);
  });

  it('fsyncs native success before POST, survives timeout, and replays once after restart', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'eden3-delivery-outbox-'));
    const filePath = join(tempDir, 'delivery-success.json');
    const firstOutbox = createDurableDeliverySuccessOutbox({ filePath });
    let observedDurableBeforePost = false;
    const first = mockBridge(
      telegramHostedConfig(),
      {
        [`/channels/runtime/turns/${RUN_A}/delivered`]: async () => {
          // Model a server commit followed by client timeout. The marker must
          // already be fsynced before the HTTP attempt begins.
          observedDurableBeforePost = firstOutbox.list().length === 1;
          throw new Error('timeout after commit');
        },
      },
      { deliverySuccessOutbox: firstOutbox },
    );
    receiveTelegramA(first.bridge);
    await first.bridge.onBeforeAgentRun(
      { accountId: 'account-a', senderId: PEER_A, prompt: 'hello', messages: [] },
      { runId: RUN_A, sessionKey: TELEGRAM_SESSION_A, messageProvider: 'telegram', agentId: 'agent-a' },
    );
    await first.bridge.onReplyPayloadSending(
      {
        kind: 'final',
        runId: RUN_A,
        payload: { text: 'assistant answer' },
        usageState: {
          usage: { input: 3, output: 2, total: 5 },
          provider: 'claude-cli',
          model: 'claude-sonnet-4-6',
        },
      },
      {
        runId: RUN_A,
        sessionKey: TELEGRAM_SESSION_A,
        channelId: 'telegram',
        accountId: 'account-a',
        messageId: '42',
      },
    );
    await first.bridge.onMessageSent(
      { to: PEER_A, content: 'assistant answer', runId: RUN_A, success: true, messageId: '9001' },
      { channelId: 'telegram', accountId: 'account-a', conversationId: PEER_A, runId: RUN_A },
    );
    expect(observedDurableBeforePost).toBe(true);
    expect(firstOutbox.list()).toHaveLength(1);

    const restartedOutbox = createDurableDeliverySuccessOutbox({ filePath });
    const restarted = mockBridge(telegramHostedConfig(), {}, {
      deliverySuccessOutbox: restartedOutbox,
    });
    await restarted.bridge.onGatewayStart();
    expect(
      restarted.calls.filter((call) => call.path === `/channels/runtime/turns/${RUN_A}/delivered`),
    ).toHaveLength(1);
    expect(restartedOutbox.list()).toEqual([]);
    await restarted.bridge.onGatewayStart();
    expect(
      restarted.calls.filter((call) => call.path === `/channels/runtime/turns/${RUN_A}/delivered`),
    ).toHaveLength(1);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('retries a transient delivery-success replay without requiring another restart', async () => {
    vi.useFakeTimers();
    const tempDir = mkdtempSync(join(tmpdir(), 'eden3-delivery-retry-'));
    try {
      const outbox = createDurableDeliverySuccessOutbox({
        filePath: join(tempDir, 'delivery-success.json'),
      });
      outbox.record({
        connectionId: CONNECTION_A,
        runtimeAccountId: 'account-a',
        channel: 'telegram',
        turnId: RUN_A,
        messageId: '9003',
      });
      let deliveryAttempts = 0;
      const replay = mockBridge(
        telegramHostedConfig(),
        {
          [`/channels/runtime/turns/${RUN_A}/delivered`]: async () => {
            deliveryAttempts += 1;
            if (deliveryAttempts === 1) throw new Error('temporary API outage');
            return { ok: true };
          },
        },
        { deliverySuccessOutbox: outbox },
      );
      await replay.bridge.onGatewayStart();
      expect(deliveryAttempts).toBe(1);
      expect(outbox.list()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(
        channelRuntimeBridgeInternals.DELIVERY_SUCCESS_REPLAY_BASE_MS,
      );
      expect(deliveryAttempts).toBe(2);
      expect(outbox.list()).toEqual([]);
    } finally {
      vi.useRealTimers();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps retrying a live native-success acknowledgement after its first POST fails', async () => {
    vi.useFakeTimers();
    const tempDir = mkdtempSync(join(tmpdir(), 'eden3-delivery-live-retry-'));
    try {
      const outbox = createDurableDeliverySuccessOutbox({
        filePath: join(tempDir, 'delivery-success.json'),
      });
      let deliveryAttempts = 0;
      const current = mockBridge(
        telegramHostedConfig(),
        {
          [`/channels/runtime/turns/${RUN_A}/delivered`]: async () => {
            deliveryAttempts += 1;
            if (deliveryAttempts === 1) throw new Error('temporary API outage');
            return { ok: true };
          },
        },
        { deliverySuccessOutbox: outbox },
      );
      receiveTelegramA(current.bridge);
      await current.bridge.onBeforeAgentRun(
        { accountId: 'account-a', senderId: PEER_A, prompt: 'hello', messages: [] },
        { runId: RUN_A, sessionKey: TELEGRAM_SESSION_A, messageProvider: 'telegram', agentId: 'agent-a' },
      );
      await current.bridge.onReplyPayloadSending(
        {
          kind: 'final',
          runId: RUN_A,
          payload: { text: 'assistant answer' },
          usageState: {
            usage: { input: 3, output: 2, total: 5 },
            provider: 'claude-cli',
            model: 'claude-sonnet-4-6',
          },
        },
        {
          runId: RUN_A,
          sessionKey: TELEGRAM_SESSION_A,
          channelId: 'telegram',
          accountId: 'account-a',
          messageId: '42',
        },
      );
      await current.bridge.onMessageSent(
        { to: PEER_A, content: 'assistant answer', runId: RUN_A, success: true, messageId: '9004' },
        { channelId: 'telegram', accountId: 'account-a', conversationId: PEER_A, runId: RUN_A },
      );
      expect(deliveryAttempts).toBe(1);
      expect(outbox.list()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(
        channelRuntimeBridgeInternals.DELIVERY_SUCCESS_REPLAY_BASE_MS,
      );
      expect(deliveryAttempts).toBe(2);
      expect(outbox.list()).toEqual([]);
    } finally {
      vi.useRealTimers();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps a loud in-memory retry when marker persistence and first ack both fail', async () => {
    vi.useFakeTimers();
    const tempDir = mkdtempSync(join(tmpdir(), 'eden3-delivery-volatile-retry-'));
    try {
      const durable = createDurableDeliverySuccessOutbox({
        filePath: join(tempDir, 'delivery-success.json'),
      });
      const outbox = {
        ...durable,
        record() {
          throw new Error('simulated fsync failure');
        },
      };
      let deliveryAttempts = 0;
      const current = mockBridge(
        telegramHostedConfig(),
        {
          [`/channels/runtime/turns/${RUN_A}/delivered`]: async () => {
            deliveryAttempts += 1;
            if (deliveryAttempts === 1) throw new Error('temporary API outage');
            return { ok: true };
          },
        },
        { deliverySuccessOutbox: outbox },
      );
      receiveTelegramA(current.bridge);
      await current.bridge.onBeforeAgentRun(
        { accountId: 'account-a', senderId: PEER_A, prompt: 'hello', messages: [] },
        { runId: RUN_A, sessionKey: TELEGRAM_SESSION_A, messageProvider: 'telegram', agentId: 'agent-a' },
      );
      await current.bridge.onReplyPayloadSending(
        {
          kind: 'final',
          runId: RUN_A,
          payload: { text: 'assistant answer' },
          usageState: {
            usage: { input: 3, output: 2, total: 5 },
            provider: 'claude-cli',
            model: 'claude-sonnet-4-6',
          },
        },
        { runId: RUN_A, sessionKey: TELEGRAM_SESSION_A, channelId: 'telegram', accountId: 'account-a', messageId: '42' },
      );
      const callsBeforeDelivery = current.calls.length;
      await current.bridge.onMessageSent(
        { to: PEER_A, content: 'assistant answer', runId: RUN_A, success: true, messageId: '9005' },
        { channelId: 'telegram', accountId: 'account-a', conversationId: PEER_A, runId: RUN_A },
      );
      expect(deliveryAttempts).toBe(1);
      expect(
        current.calls.slice(callsBeforeDelivery).some(
          (call) =>
            call.path === '/channels/runtime/status' &&
            call.body.state === 'error' &&
            call.body.errorCode === 'delivery_ack_lost',
        ),
      ).toBe(true);
      expect(
        current.calls.slice(callsBeforeDelivery).some(
          (call) => call.path === '/channels/runtime/status' && call.body.state === 'live',
        ),
      ).toBe(false);
      await vi.advanceTimersByTimeAsync(
        channelRuntimeBridgeInternals.DELIVERY_SUCCESS_REPLAY_BASE_MS,
      );
      expect(deliveryAttempts).toBe(2);
    } finally {
      vi.useRealTimers();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('quarantines a replay marker when terminal compensation already won', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'eden3-delivery-poison-'));
    const filePath = join(tempDir, 'delivery-success.json');
    const outbox = createDurableDeliverySuccessOutbox({ filePath });
    const marker = {
      connectionId: CONNECTION_A,
      runtimeAccountId: 'account-a',
      channel: 'telegram',
      turnId: RUN_A,
      messageId: '9002',
    };
    outbox.record(marker);
    outbox.record(marker);
    expect(outbox.list()).toHaveLength(1);
    expect(() => outbox.record({ ...marker, messageId: 'different' })).toThrow('marker conflict');
    const replay = mockBridge(
      telegramHostedConfig(),
      {
        [`/channels/runtime/turns/${RUN_A}/delivered`]: async () => {
          throw new ChannelRuntimeClientError('channel_turn_terminal_compensated', 409);
        },
      },
      { deliverySuccessOutbox: outbox },
    );
    await replay.bridge.onGatewayStart();
    expect(outbox.list()).toEqual([]);
    expect(outbox.listQuarantined()).toEqual([
      expect.objectContaining({ turnId: RUN_A, reason: 'terminal_compensated_before_ack' }),
    ]);
    expect(
      replay.calls.some(
        (call) =>
          call.path === '/channels/runtime/status' &&
          call.body.state === 'error' &&
          call.body.errorCode === 'delivery_ack_lost',
      ),
    ).toBe(true);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('correlates Telegram group delivery against the group chat, never the sender id', async () => {
    for (const success of [true, false]) {
      const current = mockBridge(telegramGroupHostedConfig());
      const { conversationId, sessionKey } = receiveTelegramGroup(current.bridge);
      await current.bridge.onBeforeAgentRun(
        { accountId: 'account-a', senderId: PEER_A, prompt: 'hello group', messages: [] },
        { runId: RUN_A, sessionKey, messageProvider: 'telegram', agentId: 'agent-a' },
      );
      await current.bridge.onReplyPayloadSending(
        {
          kind: 'final',
          runId: RUN_A,
          payload: { text: 'group answer' },
          usageState: {
            usage: { input: 3, output: 2, total: 5 },
            provider: 'claude-cli',
            model: 'claude-sonnet-4-6',
          },
        },
        { runId: RUN_A, sessionKey, channelId: 'telegram', accountId: 'account-a', messageId: '84' },
      );
      await current.bridge.onMessageSent(
        { to: conversationId, content: 'group answer', runId: RUN_A, success },
        { channelId: 'telegram', accountId: 'account-a', conversationId, runId: RUN_A },
      );
      const terminalPath = success
        ? `/channels/runtime/turns/${RUN_A}/delivered`
        : `/channels/runtime/turns/${RUN_A}/delivery-failed`;
      expect(current.calls.some((call) => call.path === terminalPath)).toBe(true);
    }
  });

  it('normalizes Discord user delivery targets before acknowledging the exact run', async () => {
    const { bridge, calls } = mockBridge();
    receiveA(bridge);
    await bridge.onBeforeAgentRun(
      { accountId: 'account-a', senderId: PEER_A, prompt: 'hello', messages: [] },
      { runId: RUN_A, sessionKey: SESSION_A, messageProvider: 'discord', agentId: 'agent-a' },
    );
    await bridge.onReplyPayloadSending(
      {
        kind: 'final',
        runId: RUN_A,
        payload: { text: 'assistant answer' },
        usageState: {
          usage: { input: 3, output: 2, total: 5 },
          provider: 'claude-cli',
          model: 'claude-sonnet-4-6',
        },
      },
      {
        runId: RUN_A,
        sessionKey: SESSION_A,
        channelId: 'discord',
        accountId: 'account-a',
        messageId: '1532630091471786166',
      },
    );

    await bridge.onMessageSent(
      { to: `user:${PEER_A}`, content: 'assistant answer', runId: RUN_A, success: true },
      {
        channelId: 'discord',
        accountId: 'account-a',
        conversationId: `user:${PEER_A}`,
        runId: RUN_A,
      },
    );

    expect(
      calls.some((call) => call.path === `/channels/runtime/turns/${RUN_A}/delivered`),
    ).toBe(true);
  });

  it('acknowledges an exact Discord run delivered through its opaque DM channel target', async () => {
    const { bridge, calls } = mockBridge();
    receiveA(bridge);
    await bridge.onBeforeAgentRun(
      { accountId: 'account-a', senderId: PEER_A, prompt: 'hello', messages: [] },
      { runId: RUN_A, sessionKey: SESSION_A, messageProvider: 'discord', agentId: 'agent-a' },
    );
    await bridge.onReplyPayloadSending(
      {
        kind: 'final',
        runId: RUN_A,
        payload: { text: 'assistant answer' },
        usageState: {
          usage: { input: 3, output: 2, total: 5 },
          provider: 'claude-cli',
          model: 'claude-sonnet-4-6',
        },
      },
      {
        runId: RUN_A,
        sessionKey: SESSION_A,
        channelId: 'discord',
        accountId: 'account-a',
        messageId: '1532630091471786166',
      },
    );

    // Discord's DM channel id is opaque and ordinarily differs from the
    // sender's user id. Exact run-id + event/context target correlation is
    // sufficient; the channel id must not be compared to the peer user id.
    const dmTarget = 'channel:777777777777777777';
    await bridge.onMessageSent(
      { to: dmTarget, content: 'assistant answer', runId: RUN_A, success: true },
      {
        channelId: 'discord',
        accountId: 'account-a',
        conversationId: dmTarget,
        runId: RUN_A,
      },
    );

    expect(
      calls.some((call) => call.path === `/channels/runtime/turns/${RUN_A}/delivered`),
    ).toBe(true);
  });

  it('keeps retried reply approval idempotent in exact outbound correlation', async () => {
    const { bridge, calls } = mockBridge(telegramHostedConfig());
    receiveTelegramA(bridge);
    receiveTelegramA(bridge, {
      event: { content: 'second message', messageId: '43' },
      context: { messageId: '43' },
    });
    const approve = (runId, messageId, text) =>
      bridge.onReplyPayloadSending(
        {
          kind: 'final',
          runId,
          payload: { text },
          usageState: {
            usage: { input: 3, output: 2, total: 5 },
            provider: 'claude-cli',
            model: 'claude-sonnet-4-6',
          },
        },
        {
          runId,
          sessionKey: TELEGRAM_SESSION_A,
          channelId: 'telegram',
          accountId: 'account-a',
          messageId,
        },
      );
    await bridge.onBeforeAgentRun(
      { accountId: 'account-a', senderId: PEER_A, prompt: 'first', messages: [] },
      {
        runId: RUN_A,
        sessionKey: TELEGRAM_SESSION_A,
        messageProvider: 'telegram',
        agentId: 'agent-a',
      },
    );
    await approve(RUN_A, '42', 'first answer');
    await approve(RUN_A, '42', 'first answer');
    await bridge.onBeforeAgentRun(
      { accountId: 'account-a', senderId: PEER_A, prompt: 'second', messages: [] },
      {
        runId: RUN_B,
        sessionKey: TELEGRAM_SESSION_A,
        messageProvider: 'telegram',
        agentId: 'agent-a',
      },
    );
    await approve(RUN_B, '43', 'second answer');

    bridge.onMessageSent(
      { to: PEER_A, content: 'first answer', runId: RUN_A, success: true },
      { channelId: 'telegram', accountId: 'account-a', conversationId: PEER_A, runId: RUN_A },
    );
    bridge.onMessageSent(
      { to: PEER_A, content: 'second answer', runId: RUN_B, success: false, error: 'network timeout' },
      { channelId: 'telegram', accountId: 'account-a', conversationId: PEER_A, runId: RUN_B },
    );

    await vi.waitFor(() =>
      expect(
        calls.some(
          (call) => call.path === `/channels/runtime/turns/${RUN_B}/delivery-failed`,
        ),
      ).toBe(true),
    );
    expect(
      calls.some((call) => call.path === `/channels/runtime/turns/${RUN_A}/delivery-failed`),
    ).toBe(false);
  });

  it('correlates out-of-order Telegram callbacks by exact propagated run id', async () => {
    const { bridge, calls } = mockBridge(telegramHostedConfig());
    receiveTelegramA(bridge);
    receiveTelegramA(bridge, {
      event: { content: 'second message', messageId: '43' },
      context: { messageId: '43' },
    });
    const run = async (runId, messageId, prompt, answer) => {
      await bridge.onBeforeAgentRun(
        { accountId: 'account-a', senderId: PEER_A, prompt, messages: [] },
        {
          runId,
          sessionKey: TELEGRAM_SESSION_A,
          messageProvider: 'telegram',
          agentId: 'agent-a',
        },
      );
      await bridge.onReplyPayloadSending(
        {
          kind: 'final',
          runId,
          payload: { text: answer },
          usageState: {
            usage: { input: 3, output: 2, total: 5 },
            provider: 'claude-cli',
            model: 'claude-sonnet-4-6',
          },
        },
        {
          runId,
          sessionKey: TELEGRAM_SESSION_A,
          channelId: 'telegram',
          accountId: 'account-a',
          messageId,
        },
      );
    };
    await run(RUN_A, '42', 'first', 'first answer');
    await run(RUN_B, '43', 'second', 'second answer');

    bridge.onMessageSent(
      { to: PEER_A, content: 'second answer', runId: RUN_B, success: false, error: 'network timeout' },
      { channelId: 'telegram', accountId: 'account-a', conversationId: PEER_A, runId: RUN_B },
    );
    await vi.waitFor(() =>
      expect(
        calls.some(
          (call) => call.path === `/channels/runtime/turns/${RUN_B}/delivery-failed`,
        ),
      ).toBe(true),
    );
    expect(
      calls.some((call) => call.path === `/channels/runtime/turns/${RUN_A}/delivery-failed`),
    ).toBe(false);

    bridge.onMessageSent(
      { to: PEER_A, content: 'first answer', runId: RUN_A, success: true },
      { channelId: 'telegram', accountId: 'account-a', conversationId: PEER_A, runId: RUN_A },
    );
    await Promise.resolve();
    expect(
      calls.some((call) => call.path === `/channels/runtime/turns/${RUN_A}/delivery-failed`),
    ).toBe(false);
  });

  it('does not consume a runless Telegram turn for byte-identical unrelated output', async () => {
    const { bridge, calls } = mockBridge(telegramHostedConfig());
    receiveTelegramA(bridge);
    await bridge.onBeforeAgentRun(
      { accountId: 'account-a', senderId: PEER_A, prompt: 'hello', messages: [] },
      {
        runId: RUN_A,
        sessionKey: TELEGRAM_SESSION_A,
        messageProvider: 'telegram',
        agentId: 'agent-a',
      },
    );
    await bridge.onReplyPayloadSending(
      {
        kind: 'final',
        runId: RUN_A,
        payload: { text: 'assistant answer' },
        usageState: {
          usage: { input: 3, output: 2, total: 5 },
          provider: 'claude-cli',
          model: 'claude-sonnet-4-6',
        },
      },
      {
        runId: RUN_A,
        sessionKey: TELEGRAM_SESSION_A,
        channelId: 'telegram',
        accountId: 'account-a',
        messageId: '42',
      },
    );

    bridge.onMessageSent(
      { to: PEER_A, content: 'assistant answer', success: true },
      { channelId: 'telegram', accountId: 'account-a', conversationId: PEER_A },
    );
    await Promise.resolve();
    expect(
      calls.some((call) => call.path === `/channels/runtime/turns/${RUN_A}/delivery-failed`),
    ).toBe(false);
    expect(
      calls.some((call) => call.path === `/channels/runtime/turns/${RUN_A}/delivered`),
    ).toBe(false);

    bridge.onMessageSent(
      { to: PEER_A, content: 'assistant answer', runId: RUN_A, success: false },
      { channelId: 'telegram', accountId: 'account-a', conversationId: PEER_A, runId: RUN_A },
    );
    await vi.waitFor(() =>
      expect(
        calls.some(
          (call) => call.path === `/channels/runtime/turns/${RUN_A}/delivery-failed`,
        ),
      ).toBe(true),
    );
  });

  it('fails closed when duplicate Telegram content cannot identify one turn', async () => {
    const { bridge, calls } = mockBridge(telegramHostedConfig());
    receiveTelegramA(bridge);
    receiveTelegramA(bridge, {
      event: { content: 'second message', messageId: '43' },
      context: { messageId: '43' },
    });
    const approve = async (runId, messageId, prompt) => {
      await bridge.onBeforeAgentRun(
        { accountId: 'account-a', senderId: PEER_A, prompt, messages: [] },
        {
          runId,
          sessionKey: TELEGRAM_SESSION_A,
          messageProvider: 'telegram',
          agentId: 'agent-a',
        },
      );
      await bridge.onReplyPayloadSending(
        {
          kind: 'final',
          runId,
          payload: { text: 'same answer' },
          usageState: {
            usage: { input: 3, output: 2, total: 5 },
            provider: 'claude-cli',
            model: 'claude-sonnet-4-6',
          },
        },
        {
          runId,
          sessionKey: TELEGRAM_SESSION_A,
          channelId: 'telegram',
          accountId: 'account-a',
          messageId,
        },
      );
    };
    await approve(RUN_A, '42', 'first');
    await approve(RUN_B, '43', 'second');

    bridge.onMessageSent(
      { to: PEER_A, content: 'same answer', success: false },
      { channelId: 'telegram', accountId: 'account-a', conversationId: PEER_A },
    );
    await Promise.resolve();
    expect(
      calls.some((call) => call.path.endsWith('/delivery-failed')),
    ).toBe(false);
  });

  it('does not correlate an ambiguous Telegram delivery failure', async () => {
    const { bridge, calls } = mockBridge(telegramHostedConfig());
    receiveTelegramA(bridge);
    await bridge.onBeforeAgentRun(
      { accountId: 'account-a', senderId: PEER_A, prompt: 'hello', messages: [] },
      {
        runId: RUN_A,
        sessionKey: TELEGRAM_SESSION_A,
        messageProvider: 'telegram',
        agentId: 'agent-a',
      },
    );
    await bridge.onReplyPayloadSending(
      {
        kind: 'final',
        runId: RUN_A,
        payload: { text: 'assistant answer' },
        usageState: {
          usage: { input: 3, output: 2, total: 5 },
          provider: 'claude-cli',
          model: 'claude-sonnet-4-6',
        },
      },
      {
        runId: RUN_A,
        sessionKey: TELEGRAM_SESSION_A,
        channelId: 'telegram',
        accountId: 'account-a',
        messageId: '42',
      },
    );

    bridge.onMessageSent(
      { to: PEER_A, content: 'assistant answer', runId: RUN_A, success: false, error: 'network timeout' },
      {
        channelId: 'telegram',
        accountId: 'account-a',
        conversationId: PEER_B,
        runId: RUN_A,
      },
    );
    await Promise.resolve();
    expect(
      calls.some((call) => call.path === `/channels/runtime/turns/${RUN_A}/delivery-failed`),
    ).toBe(false);

    // The mismatched event did not consume the FIFO entry; the subsequent
    // exact hook can still compensate the correct settled turn.
    bridge.onMessageSent(
      { to: PEER_A, content: 'assistant answer', runId: RUN_A, success: false, error: 'network timeout' },
      {
        channelId: 'telegram',
        accountId: 'account-a',
        conversationId: PEER_A,
        runId: RUN_A,
      },
    );
    await vi.waitFor(() =>
      expect(
        calls.some(
          (call) => call.path === `/channels/runtime/turns/${RUN_A}/delivery-failed`,
        ),
      ).toBe(true),
    );
  });

  it('keeps a wrong pre-resolved runtime visible so API rejection cancels and refunds it', async () => {
    const { bridge, calls } = mockBridge(hostedConfig(), {
      [`/channels/runtime/turns/${RUN_A}/settle`]: async (body) => {
        expect(body).toMatchObject({
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          agentRuntime: 'claude-cli',
        });
        throw new Error('execution provenance mismatch');
      },
    });
    receiveA(bridge);
    await bridge.onBeforeAgentRun(
      { accountId: 'account-a', senderId: PEER_A, prompt: 'hello', messages: [] },
      { runId: RUN_A, sessionKey: SESSION_A, messageProvider: 'discord', agentId: 'agent-a' },
    );
    // This is the exact observable shape when OpenClaw selected its native
    // provider harness before the hosted bridge forced the configured model.
    bridge.onLlmOutput(
      {
        runId: RUN_A,
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        usage: { input: 3, output: 2, total: 5 },
      },
      { runId: RUN_A },
    );

    await expect(
      bridge.onReplyPayloadSending(
        { kind: 'final', runId: RUN_A, payload: { text: 'must not escape' } },
        {
          runId: RUN_A,
          sessionKey: SESSION_A,
          channelId: 'discord',
          accountId: 'account-a',
          messageId: '1532630091471786166',
        },
      ),
    ).resolves.toEqual({ cancel: true, reason: 'Eden channel settlement failed' });
    expect(calls.some((call) => call.path === `/channels/runtime/turns/${RUN_A}/refund`)).toBe(true);
    expect(calls.some((call) => call.body?.role === 'assistant')).toBe(false);
  });

  it('retries failed refund and status callbacks instead of caching a transient failure', async () => {
    let refundAttempts = 0;
    let statusAttempts = 0;
    const { bridge } = mockBridge(hostedConfig(), {
      [`/channels/runtime/turns/${RUN_A}/refund`]: async () => {
        refundAttempts += 1;
        if (refundAttempts === 1) throw new Error('transient refund failure');
        return { ok: true };
      },
      '/channels/runtime/status': async (body) => {
        if (body.connectionId !== CONNECTION_A) return { ok: true };
        statusAttempts += 1;
        if (statusAttempts === 1) throw new Error('transient status failure');
        return { ok: true };
      },
    });
    receiveA(bridge);
    await vi.waitFor(() => expect(statusAttempts).toBe(1));
    bridge.onMessageSent(
      { success: true },
      { channelId: 'discord', accountId: 'account-a' },
    );
    await vi.waitFor(() => expect(statusAttempts).toBe(2));

    await bridge.onBeforeAgentRun(
      { accountId: 'account-a', senderId: PEER_A, prompt: 'hello', messages: [] },
      { runId: RUN_A, sessionKey: SESSION_A, messageProvider: 'discord', agentId: 'agent-a' },
    );
    await bridge.onAgentEnd(
      { runId: RUN_A, success: false, messages: [] },
      { runId: RUN_A, sessionKey: SESSION_A },
    );
    expect(refundAttempts).toBe(1);
    await bridge.onGatewayStop();
    expect(refundAttempts).toBe(2);
  });

  it('retries a startup status callback after event-loop-starved gateway startup', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const { bridge } = mockBridge(hostedConfig(), {
        '/channels/runtime/status': async () => {
          attempts += 1;
          if (attempts <= 2) throw new Error('startup transport timeout');
          return { ok: true };
        },
      });
      await bridge.onGatewayStart();
      expect(attempts).toBe(2);
      await vi.advanceTimersByTimeAsync(
        channelRuntimeBridgeInternals.STARTUP_STATUS_RETRY_MS,
      );
      expect(attempts).toBe(4);
      await bridge.onGatewayStop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains an in-flight reservation beyond the 30-minute provider timeout ceiling', async () => {
    vi.useFakeTimers();
    try {
      const { bridge, calls } = mockBridge();
      receiveA(bridge);
      await bridge.onBeforeAgentRun(
        { accountId: 'account-a', senderId: PEER_A, prompt: 'long work', messages: [] },
        { runId: RUN_A, sessionKey: SESSION_A, messageProvider: 'discord', agentId: 'agent-a' },
      );
      await vi.advanceTimersByTimeAsync(30 * 60 * 1_000 + 30_000);
      expect(calls.some((call) => call.path.endsWith('/refund'))).toBe(false);
      await vi.advanceTimersByTimeAsync(
        channelRuntimeBridgeInternals.STATE_TTL_MS - (30 * 60 * 1_000 + 30_000),
      );
      expect(calls.some((call) => call.path.endsWith('/refund'))).toBe(true);
      await expect(
        bridge.onReplyPayloadSending(
          { kind: 'final', runId: RUN_A, payload: { text: 'late output' } },
          {
            runId: RUN_A,
            sessionKey: SESSION_A,
            channelId: 'discord',
            accountId: 'account-a',
          },
        ),
      ).resolves.toEqual({
        cancel: true,
        reason: 'Eden channel turn correlation unavailable',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('blocks a queued turn when the published agent binding generation changes', async () => {
    const config = hostedConfig();
    const oldBinding = '33333333-3333-4333-8333-333333333333';
    const newBinding = '44444444-4444-4444-8444-444444444444';
    config.plugins.entries['eden3-channel-runtime'].config.accounts[0].bindingId = oldBinding;
    const { bridge, calls } = mockBridge(config);
    receiveA(bridge);
    config.plugins.entries['eden3-channel-runtime'].config.accounts[0].bindingId = newBinding;

    await expect(
      bridge.onBeforeAgentRun(
        { accountId: 'account-a', senderId: PEER_A, prompt: 'stale queued turn', messages: [] },
        {
          runId: RUN_A,
          sessionKey: SESSION_A,
          messageProvider: 'discord',
          agentId: 'agent-a',
        },
      ),
    ).resolves.toMatchObject({ outcome: 'block' });
    expect(calls.some((call) => call.path === '/channels/runtime/turns/reserve')).toBe(false);
    expect(calls.find((call) => call.path === '/channels/runtime/messages').body).toMatchObject({
      agentId: 'agent-a',
      bindingId: oldBinding,
    });
  });

  it('forwards native pairing code privately and reports reconnect/error lifecycle', async () => {
    const { bridge, calls } = mockBridge();
    await bridge.onPairingRequested(
      { channel: 'discord', accountId: 'account-a', senderId: PEER_A, code: 'one-time-code' },
      { channelId: 'discord', accountId: 'account-a', senderId: PEER_A },
    );
    await bridge.onGatewayStart();
    bridge.onMessageSent(
      { success: false, content: 'not inspected' },
      { channelId: 'discord', accountId: 'account-a' },
    );
    await bridge.onGatewayStop();
    expect(calls.find((call) => call.path.endsWith('/pairing')).body).toEqual({
      connectionId: CONNECTION_A,
      runtimeAccountId: 'account-a',
      agentId: 'agent-a',
      peerId: PEER_A,
      code: 'one-time-code',
    });
    expect(calls.filter((call) => call.path.endsWith('/status')).map((call) => call.body)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ connectionId: CONNECTION_A, state: 'live' }),
        expect.objectContaining({ connectionId: CONNECTION_A, state: 'error', errorCode: 'provider_unavailable' }),
        expect.objectContaining({ connectionId: CONNECTION_A, state: 'stopped' }),
      ]),
    );
  });

  it('retries a transient pairing callback, coalesces duplicates, and resumes after restart', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const { bridge, calls } = mockBridge(hostedConfig(), {
        '/channels/runtime/pairing': async () => {
          attempts += 1;
          if (attempts < 3) throw new Error('transient callback outage');
          return { ok: true };
        },
      });
      const event = {
        channel: 'discord',
        accountId: 'account-a',
        senderId: PEER_A,
        code: 'one-time-code',
      };
      const context = {
        channelId: 'discord',
        accountId: 'account-a',
        senderId: PEER_A,
      };

      await bridge.onPairingRequested(event, context);
      expect(attempts).toBe(1);

      // Native providers may repeat the same event while Eden is unavailable.
      // One pending code must retain one retry loop rather than multiplying work.
      await bridge.onPairingRequested(event, context);
      expect(attempts).toBe(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(attempts).toBe(2);

      await bridge.onGatewayStop();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(attempts).toBe(2);

      // A same-process gateway reconnect retries the retained private code once;
      // success removes it so no later backoff can duplicate the request.
      await bridge.onGatewayStart();
      expect(attempts).toBe(3);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(attempts).toBe(3);

      const pairingCalls = calls.filter((call) => call.path.endsWith('/pairing'));
      expect(pairingCalls).toHaveLength(3);
      expect(pairingCalls.every((call) => call.options?.timeoutMs === 1_500)).toBe(true);
      expect(pairingCalls.map((call) => call.body)).toEqual([
        expect.objectContaining({ peerId: PEER_A, code: 'one-time-code' }),
        expect.objectContaining({ peerId: PEER_A, code: 'one-time-code' }),
        expect.objectContaining({ peerId: PEER_A, code: 'one-time-code' }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaces a stale pairing code and expires an undeliverable code without a retry storm', async () => {
    vi.useFakeTimers();
    try {
      const seenCodes = [];
      let releaseOld;
      const oldInFlight = new Promise((resolve) => {
        releaseOld = resolve;
      });
      const { bridge } = mockBridge(
        hostedConfig(),
        {
          '/channels/runtime/pairing': async (body) => {
            seenCodes.push(body.code);
            if (body.code === 'old-code') await oldInFlight;
            return { ok: true };
          },
        },
        { now: Date.now },
      );
      const context = {
        channelId: 'discord',
        accountId: 'account-a',
        senderId: PEER_A,
      };

      const oldAttempt = bridge.onPairingRequested(
        { channel: 'discord', accountId: 'account-a', senderId: PEER_A, code: 'old-code' },
        context,
      );
      await vi.waitFor(() => expect(seenCodes).toEqual(['old-code']));
      const newAttempt = bridge.onPairingRequested(
        { channel: 'discord', accountId: 'account-a', senderId: PEER_A, code: 'new-code' },
        context,
      );
      expect(seenCodes).toEqual(['old-code']);
      releaseOld();
      await Promise.all([oldAttempt, newAttempt]);
      expect(seenCodes).toEqual(['old-code', 'new-code']);

      const alwaysFailing = mockBridge(
        hostedConfig(),
        {
          '/channels/runtime/pairing': async () => {
            throw new Error('sustained callback outage');
          },
        },
        { now: Date.now },
      );
      await alwaysFailing.bridge.onPairingRequested(
        {
          channel: 'discord',
          accountId: 'account-a',
          senderId: PEER_A,
          code: 'expiring-code',
        },
        context,
      );
      await vi.advanceTimersByTimeAsync(
        channelRuntimeBridgeInternals.PAIRING_CALLBACK_TTL_MS +
          channelRuntimeBridgeInternals.PAIRING_CALLBACK_RETRY_MAX_MS,
      );
      const attemptsAtExpiry = alwaysFailing.calls.filter((call) =>
        call.path.endsWith('/pairing'),
      ).length;
      await vi.advanceTimersByTimeAsync(
        channelRuntimeBridgeInternals.PAIRING_CALLBACK_RETRY_MAX_MS * 4,
      );
      expect(alwaysFailing.calls.filter((call) => call.path.endsWith('/pairing'))).toHaveLength(
        attemptsAtExpiry,
      );
      expect(attemptsAtExpiry).toBeLessThan(30);
    } finally {
      vi.useRealTimers();
    }
  });

  it('encrypts a failed pairing callback and replays it once after a full process restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'eden3-pairing-callback-'));
    const filePath = join(directory, 'pairing-callbacks.json');
    const secret = 'synthetic-gateway-token-for-pairing-outbox';
    try {
      const firstOutbox = createDurablePairingCallbackOutbox({ filePath, secret });
      const first = mockBridge(
        hostedConfig(),
        {
          '/channels/runtime/pairing': async () => {
            throw new Error('API unavailable before process death');
          },
        },
        { pairingCallbackOutbox: firstOutbox, now: Date.now },
      );
      await first.bridge.onPairingRequested(
        {
          channel: 'discord',
          accountId: 'account-a',
          senderId: PEER_A,
          code: 'private-one-time-code',
        },
        { channelId: 'discord', accountId: 'account-a', senderId: PEER_A },
      );
      await first.bridge.onGatewayStop();

      const stored = readFileSync(filePath, 'utf8');
      expect(stored).not.toContain('private-one-time-code');
      expect(stored).not.toContain(PEER_A);
      expect(firstOutbox.list()).toHaveLength(1);

      const recoveredOutbox = createDurablePairingCallbackOutbox({ filePath, secret });
      const recovered = mockBridge(
        hostedConfig(),
        { '/channels/runtime/pairing': async () => ({ ok: true }) },
        { pairingCallbackOutbox: recoveredOutbox, now: Date.now },
      );
      await recovered.bridge.onGatewayStart();
      expect(recovered.calls.filter((call) => call.path.endsWith('/pairing'))).toHaveLength(1);
      expect(recovered.calls.find((call) => call.path.endsWith('/pairing')).body).toMatchObject({
        connectionId: CONNECTION_A,
        peerId: PEER_A,
        code: 'private-one-time-code',
      });
      expect(recoveredOutbox.list()).toEqual([]);
      await recovered.bridge.onGatewayStop();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('runtime callback HTTP client', () => {
  it('permits only the fixed local callback transport', () => {
    expect(validateChannelRuntimeBaseUrl('http://host.docker.internal:4312')).toBe(
      'http://host.docker.internal:4312',
    );
    for (const url of [
      'http://host.docker.internal:4301',
      'https://host.docker.internal:4312',
      'http://example.com:4312',
      'http://user:pass@host.docker.internal:4312',
      'http://127.0.0.1:4312',
      'http://host.docker.internal:4312/path',
      'http://host.docker.internal:4312/?redirect=evil',
    ]) {
      expect(() => validateChannelRuntimeBaseUrl(url)).toThrow(ChannelRuntimeClientError);
    }
  });

  it('uses the existing bearer without exposing it in failures or following redirects', async () => {
    const bearer = 'test-gateway-token-do-not-log';
    const seen = [];
    const fetchFn = vi.fn(async (url, init) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ ok: false, error: { code: 'forbidden' }, detail: bearer }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = createChannelRuntimeClient({
      baseUrl: 'http://host.docker.internal:4312',
      bearer,
      fetchFn,
    });
    let caught;
    try {
      await client.post('/channels/runtime/status', { state: 'live' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'forbidden', status: 403 });
    expect(String(caught)).not.toContain(bearer);
    expect(String(caught)).not.toContain('detail');
    expect(seen[0].init.redirect).toBe('error');
    expect(seen[0].init.headers.authorization).toBe(`Bearer ${bearer}`);
  });

  it('rejects missing auth, path injection, and oversized responses with narrow errors', async () => {
    const missing = createChannelRuntimeClient({
      baseUrl: 'http://host.docker.internal:4312',
      bearer: '',
      fetchFn: vi.fn(),
    });
    await expect(missing.post('/channels/runtime/status', {})).rejects.toMatchObject({
      code: 'runtime_auth_unavailable',
    });

    const client = createChannelRuntimeClient({
      baseUrl: 'http://host.docker.internal:4312',
      bearer: 'a-valid-test-bearer',
      fetchFn: vi.fn(async () => new Response('x'.repeat(70_000), { status: 200 })),
    });
    await expect(client.post('/channels/runtime/../../secrets', {})).rejects.toMatchObject({
      code: 'invalid_runtime_path',
    });
    await expect(client.post('/channels/runtime/status', {})).rejects.toMatchObject({
      code: 'runtime_response_too_large',
    });
  });
});
