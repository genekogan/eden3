import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { loadRootEnv, pg } from '@eden3/db';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildServer } from '../src/server';
import type { ReserveChannelTurnInput } from '../src/services/channel-metering';
import type { ChannelProviderClientLike } from '../src/services/channel-provider';
import {
  AesGcmSecretVault,
  channelTokenSecretContext,
} from '../src/services/secret-vault';
import {
  deleteFixturesByMarker,
  devCookie,
  insertAgentAccount,
  insertUserAccount,
  makeMarker,
} from './fixtures';

loadRootEnv();

const marker = makeMarker('channels');
const vault = new AesGcmSecretVault({ key: randomBytes(32).toString('base64') });
const runtimeToken = 'channel-runtime-test-credential';
let ownerId = '';
let strangerId = '';
let firstAgentId = '';
let firstAgentUsername = '';
let secondAgentUsername = '';
let app: FastifyInstance;

const ensureCalls: Array<Record<string, unknown>> = [];
const removeCalls: Array<Record<string, unknown>> = [];
let ensureFailuresRemaining = 0;
const fakeChannelSync = {
  async ensureHostedChannelAccount(opts: Record<string, unknown>) {
    ensureCalls.push(opts);
    if (ensureFailuresRemaining > 0) {
      ensureFailuresRemaining -= 1;
      throw new Error('fixture config write failed');
    }
    return { changed: true };
  },
  async removeHostedChannelAccount(opts: Record<string, unknown>) {
    removeCalls.push(opts);
    return { changed: true };
  },
};

const providerClient: ChannelProviderClientLike = {
  async validate(channel, token) {
    if (token.includes('bad')) {
      return {
        ok: false,
        code: 'invalid_token',
        message: 'The provider rejected this bot token.',
        retryable: false,
      };
    }
    const explicitBotId = /bot-(\d{6,25})/.exec(token)?.[1];
    const tokenBotId = BigInt(`0x${createHash('sha256').update(token).digest('hex').slice(0, 12)}`)
      .toString()
      .slice(0, 18);
    return {
      ok: true,
      bot: {
        id: explicitBotId ?? tokenBotId,
        username: `${channel}_fixture_bot`,
        displayName: 'Fixture Bot',
      },
    };
  },
  async discoverDestinations(channel) {
    return channel === 'discord'
      ? [
          {
            guildId: '111111',
            guildName: 'Eden Test',
            channelId: '222222',
            channelName: 'general',
          },
        ]
      : [];
  },
};

const sessionSync = {
  syncMessage: vi.fn(async () => ({
    sessionId: randomUUID(),
    messageId: randomUUID(),
    inserted: true,
    memoryContext: {
      linkState: 'pseudonymous' as const,
      relativePath: 'memory/users/channel-peer-fixture.md',
    },
  })),
};

const turnMetering = {
  reserve: vi.fn(async (input: ReserveChannelTurnInput) => ({
    turn: {
      turnId: input.turnId,
      connectionId: input.connectionId,
      runtimeAccountId: input.runtimeAccountId,
      accountId: ownerId,
      agentId: firstAgentId,
      channel: 'discord' as const,
      model: 'anthropic/claude-haiku-4-5',
      agentRuntime: 'openclaw' as const,
      pricingBasis: 'provider-api' as const,
      sessionId: input.sessionId ?? null,
      externalMessageId: input.externalMessageId ?? null,
      status: 'reserved' as const,
      reservedManna: 1,
      meteredManna: null,
      provenanceStatus: 'frozen' as const,
    },
    balance: 99,
    replayed: false,
  })),
  settle: vi.fn(async () => ({
    chargedManna: 1,
    metering: {
      status: 'metered' as const,
      provider: 'anthropic' as const,
      model: 'claude-haiku-4-5',
      modelSource: 'agent' as const,
      tableVersion: 'test',
      costUsd: 0.001,
      manna: 1,
      estimated: false,
      lineItems: [],
    },
  })),
  refund: vi.fn(async () => {}),
  refundDeliveryFailure: vi.fn(async () => {}),
  markDelivered: vi.fn(async () => {}),
};

interface ConnectionDto {
  id: string;
  accountId: string;
  agentId: string | null;
  channel: 'discord' | 'telegram';
  runtimeAccountId: string;
  desiredState: 'inactive' | 'active';
  observedState: string;
  status: string;
  tokenPreview: string | null;
  lastError: { code: string; message: string } | null;
  bot: { username: string | null } | null;
}

async function createConnection(params: {
  token: string;
  channel?: 'discord' | 'telegram';
  agentUsername?: string;
  label?: string;
}): Promise<ConnectionDto> {
  const response = await app.inject({
    method: 'POST',
    url: '/channels/connections',
    headers: { cookie: devCookie(ownerId) },
    payload: {
      channel: params.channel ?? 'discord',
      token: params.token,
      ...(params.agentUsername ? { agentUsername: params.agentUsername } : {}),
      ...(params.label ? { label: params.label } : {}),
    },
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { connection: ConnectionDto }).connection;
}

beforeAll(async () => {
  ownerId = await insertUserAccount(`${marker}_owner`);
  strangerId = await insertUserAccount(`${marker}_stranger`);
  firstAgentUsername = `${marker}-first`;
  secondAgentUsername = `${marker}-second`;
  firstAgentId = await insertAgentAccount(firstAgentUsername, {
    ownerId,
    public: true,
    openclawId: firstAgentUsername,
    provisionStatus: 'ready',
  });
  await insertAgentAccount(secondAgentUsername, {
    ownerId,
    public: true,
    openclawId: secondAgentUsername,
    provisionStatus: 'ready',
  });
  app = await buildServer({
    gateway: null,
    channels: {
      vault,
      channelSync: fakeChannelSync,
      providerClient,
      sessionSync,
      turnMetering,
      runtimeToken,
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await deleteFixturesByMarker(marker);
  await pg.end({ timeout: 5 });
});

describe('channel custody and validation', () => {
  it('stores only AES ciphertext, returns preview metadata, and audits storage', async () => {
    const token = `valid_${marker}_secret_1234`;
    const connection = await createConnection({
      token,
      agentUsername: firstAgentUsername,
      label: 'first Discord bot',
    });
    expect(connection).toMatchObject({
      accountId: ownerId,
      agentId: firstAgentId,
      channel: 'discord',
      desiredState: 'inactive',
      observedState: 'verified',
      tokenPreview: '1234',
      bot: { username: 'discord_fixture_bot' },
    });

    const rows = await pg<
      Array<{
        token_ciphertext: string;
        token_iv: string;
        token_auth_tag: string;
        token_sha256: string;
        key_version: string;
      }>
    >`
      select token_ciphertext, token_iv, token_auth_tag, token_sha256, key_version
      from channel_connections where id = ${connection.id}
    `;
    expect(JSON.stringify(rows[0])).not.toContain(token);
    expect(rows[0]!.token_sha256).toBe(createHash('sha256').update(token).digest('hex'));
    expect(
      vault.decrypt(
        {
          tokenCiphertext: rows[0]!.token_ciphertext,
          tokenIv: rows[0]!.token_iv,
          tokenAuthTag: rows[0]!.token_auth_tag,
          keyVersion: rows[0]!.key_version,
        },
        channelTokenSecretContext({
          connectionId: connection.id,
          accountId: ownerId,
          channel: 'discord',
        }),
      ),
    ).toBe(token);

    const list = await app.inject({
      method: 'GET',
      url: '/channels/connections',
      headers: { cookie: devCookie(ownerId) },
    });
    expect(list.statusCode).toBe(200);
    expect(list.body).toContain(connection.id);
    expect(list.body).not.toContain(token);
    expect(list.body).not.toContain('token_ciphertext');
  });

  it('retains an invalid token as a clear error and rotates it safely on retry', async () => {
    const connection = await createConnection({ token: `bad_${marker}_9999` });
    expect(connection.observedState).toBe('error');
    expect(connection.lastError).toMatchObject({ code: 'invalid_token' });

    const retried = await app.inject({
      method: 'POST',
      url: `/channels/connections/${connection.id}/retry`,
      headers: { cookie: devCookie(ownerId) },
      payload: { token: `valid_${marker}_replacement_7777` },
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({
      ok: true,
      connection: { observedState: 'verified', tokenPreview: '7777', lastError: null },
    });
    expect(retried.body).not.toContain(`valid_${marker}_replacement_7777`);
  });

  it('discovers Discord destinations only after an audited vault read', async () => {
    const connection = await createConnection({ token: `valid_${marker}_discover_4444` });
    const response = await app.inject({
      method: 'GET',
      url: `/channels/connections/${connection.id}/destinations`,
      headers: { cookie: devCookie(ownerId) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      items: [{ guildId: '111111', channelId: '222222' }],
    });
    const audits = await pg<{ action: string }[]>`
      select action from secret_access_audit_events
      where secret_id = ${connection.id} order by created_at, id
    `;
    expect(audits.map((row) => row.action)).toContain('destination_discovery');
  });

  it('does not expose another owner connection', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/channels/connections',
      headers: { cookie: devCookie(strangerId) },
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { items: unknown[] }).items).toEqual([]);
  });

  it('rejects duplicate tokens and provider bot identities across connections and rotation', async () => {
    const botId = '987654321';
    const first = await createConnection({
      token: `valid_${marker}_bot-${botId}_first`,
    });
    const duplicateCreate = await app.inject({
      method: 'POST',
      url: '/channels/connections',
      headers: { cookie: devCookie(ownerId) },
      payload: {
        channel: 'discord',
        token: `valid_${marker}_bot-${botId}_different-token`,
      },
    });
    expect(duplicateCreate.statusCode).toBe(409);
    expect(duplicateCreate.json()).toMatchObject({
      error: { code: 'channel_credential_in_use' },
    });

    const second = await createConnection({ token: `valid_${marker}_rotation_source` });
    const duplicateRotation = await app.inject({
      method: 'POST',
      url: `/channels/connections/${second.id}/retry`,
      headers: { cookie: devCookie(ownerId) },
      payload: { token: `valid_${marker}_bot-${botId}_rotation` },
    });
    expect(duplicateRotation.statusCode).toBe(409);
    expect(duplicateRotation.body).not.toContain(first.id);
  });
});

describe('named-account lifecycle', () => {
  it('activates two isolated Discord bots and one Telegram bot without a plaintext token', async () => {
    ensureCalls.length = 0;
    const first = await createConnection({
      token: `valid_${marker}_discord_one_1111`,
      agentUsername: firstAgentUsername,
    });
    const second = await createConnection({
      token: `valid_${marker}_discord_two_2222`,
      agentUsername: secondAgentUsername,
    });
    const telegram = await createConnection({
      token: `valid_${marker}_telegram_3333`,
      channel: 'telegram',
      agentUsername: firstAgentUsername,
    });

    for (const connection of [first, second, telegram]) {
      const response = await app.inject({
        method: 'POST',
        url: `/channels/connections/${connection.id}/activate`,
        headers: { cookie: devCookie(ownerId) },
        payload: {
          dmPolicy: 'pairing',
          allowFrom: [],
          discordGuilds: [],
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ok: true,
        connection: { desiredState: 'active', observedState: 'starting' },
      });
      expect(response.body).not.toContain(`valid_${marker}`);
    }

    expect(new Set(ensureCalls.map((call) => call.runtimeAccountId)).size).toBe(3);
    expect(ensureCalls.map((call) => call.connectionId)).toEqual([
      first.id,
      second.id,
      telegram.id,
    ]);
    expect(JSON.stringify(ensureCalls)).not.toContain(`valid_${marker}`);
  });

  it('rejects Discord guild delivery before token or provider work', async () => {
    const connection = await createConnection({
      token: `valid_${marker}_dm_only_4444`,
      agentUsername: firstAgentUsername,
    });
    const decryptSpy = vi.spyOn(vault, 'decrypt');
    const validateSpy = vi.spyOn(providerClient, 'validate');
    const ensureCallCount = ensureCalls.length;
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/channels/connections/${connection.id}/activate`,
        headers: { cookie: devCookie(ownerId) },
        payload: {
          dmPolicy: 'pairing',
          allowFrom: [],
          discordGuilds: [{ guildId: '111111', channelIds: ['222222'] }],
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.body).toContain('guild/channel activation is disabled');
      expect(decryptSpy).not.toHaveBeenCalled();
      expect(validateSpy).not.toHaveBeenCalled();
      expect(ensureCalls).toHaveLength(ensureCallCount);
    } finally {
      decryptSpy.mockRestore();
      validateSpy.mockRestore();
    }
  });

  it('deactivates, reactivates, then deletes exactly one named account', async () => {
    removeCalls.length = 0;
    const connection = await createConnection({
      token: `valid_${marker}_lifecycle_5555`,
      agentUsername: firstAgentUsername,
    });
    await app.inject({
      method: 'POST',
      url: `/channels/connections/${connection.id}/activate`,
      headers: { cookie: devCookie(ownerId) },
      payload: { dmPolicy: 'allowlist', allowFrom: ['123456'], discordGuilds: [] },
    });
    const paused = await app.inject({
      method: 'POST',
      url: `/channels/connections/${connection.id}/deactivate`,
      headers: { cookie: devCookie(ownerId) },
      payload: {},
    });
    expect(paused.json()).toMatchObject({
      connection: { desiredState: 'inactive', observedState: 'stopped' },
    });
    const reactivated = await app.inject({
      method: 'POST',
      url: `/channels/connections/${connection.id}/activate`,
      headers: { cookie: devCookie(ownerId) },
      payload: { dmPolicy: 'allowlist', allowFrom: ['123456'], discordGuilds: [] },
    });
    expect(reactivated.statusCode).toBe(200);
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/channels/connections/${connection.id}`,
      headers: { cookie: devCookie(ownerId) },
    });
    expect(deleted.statusCode).toBe(200);
    expect(removeCalls).toEqual([
      expect.objectContaining({ runtimeAccountId: connection.runtimeAccountId, deleteAccount: false }),
      expect.objectContaining({ runtimeAccountId: connection.runtimeAccountId, deleteAccount: true }),
    ]);
    const rows = await pg<{ count: number }[]>`
      select count(*)::int as count from channel_connections where id = ${connection.id}
    `;
    expect(rows[0]!.count).toBe(0);
  });

  it('keeps desired state active across a transient runtime stop so it can reconnect', async () => {
    const connection = await createConnection({
      token: `valid_${marker}_transient_stop`,
      agentUsername: firstAgentUsername,
    });
    const activated = await app.inject({
      method: 'POST',
      url: `/channels/connections/${connection.id}/activate`,
      headers: { cookie: devCookie(ownerId) },
      payload: { dmPolicy: 'pairing', allowFrom: [], discordGuilds: [] },
    });
    expect(activated.statusCode).toBe(200);
    const stopped = await app.inject({
      method: 'POST',
      url: '/channels/runtime/status',
      headers: { authorization: `Bearer ${runtimeToken}` },
      payload: {
        connectionId: connection.id,
        runtimeAccountId: connection.runtimeAccountId,
        state: 'stopped',
      },
    });
    expect(stopped.statusCode).toBe(200);
    const rows = await pg<
      Array<{ desired_state: string; observed_state: string; status: string }>
    >`
      select desired_state, observed_state, status
      from channel_connections
      where id = ${connection.id}
    `;
    expect(rows[0]).toEqual({
      desired_state: 'active',
      observed_state: 'stopped',
      status: 'reconnecting',
    });
  });
});

describe('pairing claim and verified identity linkage', () => {
  async function activePairingConnection(suffix: string): Promise<ConnectionDto> {
    const connection = await createConnection({
      token: `valid_${marker}_${suffix}`,
      agentUsername: firstAgentUsername,
    });
    const activated = await app.inject({
      method: 'POST',
      url: `/channels/connections/${connection.id}/activate`,
      headers: { cookie: devCookie(ownerId) },
      payload: { dmPolicy: 'pairing', allowFrom: [], discordGuilds: [] },
    });
    expect(activated.statusCode).toBe(200);
    return connection;
  }

  it('requires the encrypted native code before linking to the authenticated account', async () => {
    const connection = await activePairingConnection('verified_pairing');
    const peerId = '77441122';
    const code = 'EDEN-9142';
    const paired = await app.inject({
      method: 'POST',
      url: '/channels/runtime/pairing',
      headers: { authorization: `Bearer ${runtimeToken}` },
      payload: {
        connectionId: connection.id,
        runtimeAccountId: connection.runtimeAccountId,
        peerId,
        code,
      },
    });
    expect(paired.statusCode).toBe(200);
    const requestId = (paired.json() as { requestId: string }).requestId;
    const encryptedRows = await pg<{ metadata: unknown }[]>`
      select metadata from channel_pairing_requests where id = ${requestId}
    `;
    expect(JSON.stringify(encryptedRows[0]?.metadata)).not.toContain(code);

    const forged = await app.inject({
      method: 'POST',
      url: `/channels/connections/${connection.id}/pairing/${requestId}/approve`,
      headers: { cookie: devCookie(ownerId) },
      payload: { linkToMyAccount: true, pairingCode: 'WRONG-CODE' },
    });
    expect(forged.statusCode).toBe(403);
    const afterForged = await pg<{ status: string; linked_account_id: string | null }[]>`
      select p.status, i.linked_account_id
      from channel_pairing_requests p
      join channel_external_identities i on i.id = p.identity_id
      where p.id = ${requestId}
    `;
    expect(afterForged[0]).toEqual({ status: 'pending', linked_account_id: null });

    const approved = await app.inject({
      method: 'POST',
      url: `/channels/connections/${connection.id}/pairing/${requestId}/approve`,
      headers: { cookie: devCookie(ownerId) },
      payload: { linkToMyAccount: true, pairingCode: code },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toEqual({ ok: true, linkedToMyAccount: true });
    const linked = await pg<
      Array<{ status: string; linked_account_id: string | null; metadata: unknown }>
    >`
      select p.status, i.linked_account_id, p.metadata
      from channel_pairing_requests p
      join channel_external_identities i on i.id = p.identity_id
      where p.id = ${requestId}
    `;
    expect(linked[0]?.status).toBe('approved');
    expect(linked[0]?.linked_account_id).toBe(ownerId);
    expect(JSON.stringify(linked[0]?.metadata)).not.toContain('pairingCode');
  });

  it('compensates the DB claim and allowlist when gateway config application fails', async () => {
    const connection = await activePairingConnection('pairing_compensation');
    const peerId = '77443355';
    const paired = await app.inject({
      method: 'POST',
      url: '/channels/runtime/pairing',
      headers: { authorization: `Bearer ${runtimeToken}` },
      payload: {
        connectionId: connection.id,
        runtimeAccountId: connection.runtimeAccountId,
        peerId,
        code: 'EDEN-2211',
      },
    });
    const requestId = (paired.json() as { requestId: string }).requestId;
    ensureFailuresRemaining = 1;
    const approval = await app.inject({
      method: 'POST',
      url: `/channels/connections/${connection.id}/pairing/${requestId}/approve`,
      headers: { cookie: devCookie(ownerId) },
      payload: {},
    });
    expect(approval.statusCode).toBe(502);
    const rows = await pg<
      Array<{ status: string; desired_state: string; metadata: unknown }>
    >`
      select p.status, c.desired_state, c.metadata
      from channel_pairing_requests p
      join channel_connections c on c.id = p.connection_id
      where p.id = ${requestId}
    `;
    expect(rows[0]?.status).toBe('pending');
    expect(rows[0]?.desired_state).toBe('active');
    expect(JSON.stringify(rows[0]?.metadata)).not.toContain(peerId);
    expect((rows[0]?.metadata as { config?: { allowFrom?: string[] } }).config?.allowFrom).not.toContain(
      peerId,
    );
  });
});

describe('private runtime callbacks', () => {
  it('rejects unauthenticated sync and accepts an exact bearer credential', async () => {
    sessionSync.syncMessage.mockClear();
    const body = {
      connectionId: randomUUID(),
      runtimeAccountId: 'eden-runtime',
      gatewaySessionKey: 'agent:fixture:discord:eden-runtime:direct:123456',
      peerId: '123456',
      externalMessageId: 'discord:message:1',
      role: 'user',
      content: 'hello',
      createdAt: '2026-07-31T12:00:00.000Z',
      sourceSequence: 1,
    };
    const denied = await app.inject({ method: 'POST', url: '/channels/runtime/messages', payload: body });
    expect(denied.statusCode).toBe(401);
    expect(sessionSync.syncMessage).not.toHaveBeenCalled();

    const accepted = await app.inject({
      method: 'POST',
      url: '/channels/runtime/messages',
      headers: { authorization: `Bearer ${runtimeToken}` },
      payload: body,
    });
    expect(accepted.statusCode).toBe(200);
    expect(sessionSync.syncMessage).toHaveBeenCalledWith({
      ...body,
      createdAt: new Date(body.createdAt),
    });
  });

  it('exposes authenticated reserve, settle, and refund transitions', async () => {
    const turnId = randomUUID();
    const headers = { authorization: `Bearer ${runtimeToken}` };
    const reserve = await app.inject({
      method: 'POST',
      url: '/channels/runtime/turns/reserve',
      headers,
      payload: {
        turnId,
        connectionId: randomUUID(),
        runtimeAccountId: 'eden-runtime',
      },
    });
    expect(reserve.statusCode).toBe(200);
    expect(reserve.json()).toMatchObject({ turnId, reservedManna: 1, balance: 99 });

    const settle = await app.inject({
      method: 'POST',
      url: `/channels/runtime/turns/${turnId}/settle`,
      headers,
      payload: {
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        agentRuntime: 'openclaw',
      },
    });
    expect(settle.statusCode).toBe(200);
    expect(turnMetering.settle).toHaveBeenCalledWith(
      turnId,
      expect.objectContaining({ totalTokens: 12 }),
      {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        agentRuntime: 'openclaw',
      },
    );

    const refunded = await app.inject({
      method: 'POST',
      url: `/channels/runtime/turns/${turnId}/refund`,
      headers,
      payload: {},
    });
    expect(refunded.statusCode).toBe(200);
    expect(turnMetering.refund).toHaveBeenCalledWith(turnId);
  });
});
