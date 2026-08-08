import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { credit, DevAuthProvider, getBalance } from '@eden3/core';
import { loadRootEnv, pg } from '@eden3/db';
import { hostedChannelSecretRef } from '@eden3/gateway';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildServer } from '../src/server';
import type { ReserveChannelTurnInput } from '../src/services/channel-metering';
import {
  ChannelDeliveryTerminalCompensatedError,
  ChannelTurnMeteringService,
  PostgresChannelTurnStore,
  channelTurnLedgerKey,
} from '../src/services/channel-metering';
import type { ChannelProviderClientLike } from '../src/services/channel-provider';
import {
  AesGcmSecretVault,
  channelPeerSecretContext,
  channelTokenSecretContext,
} from '../src/services/secret-vault';
import { PostgresChannelCredentialCustody } from '../src/services/postgres-channel-connector-custody';
import { PostgresTelegramManagedBotCustody } from '../src/services/postgres-telegram-managed-bot-custody';
import {
  ChannelSessionSync,
  PostgresChannelSessionSyncStore,
  channelConversationFingerprint,
  channelPeerFingerprint,
} from '../src/services/channel-session-sync';
import { XByoConnectorService, type XUserClientLike } from '../src/services/x-byo-connector';
import type { TelegramManagedBotApiClientLike } from '../src/services/telegram-managed-bots';
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
let adminId = '';
let firstAgentId = '';
let firstAgentUsername = '';
let secondAgentId = '';
let secondAgentUsername = '';
let adminAgentUsername = '';
let app: FastifyInstance;

const ensureCalls: Array<Record<string, unknown>> = [];
const removeCalls: Array<Record<string, unknown>> = [];
const activeRuntimeAccounts = new Set<string>();
let ensureFailuresRemaining = 0;
let ensurePause: Promise<void> | null = null;
let ensureEntered: (() => void) | null = null;
let removePause: Promise<void> | null = null;
let removeEntered: (() => void) | null = null;
let providerValidationPause: Promise<void> | null = null;
let providerValidationEntered: (() => void) | null = null;
const fakeChannelSync = {
  async ensureHostedChannelAccount(opts: Record<string, unknown>) {
    ensureCalls.push(opts);
    if (ensurePause) {
      ensureEntered?.();
      await ensurePause;
    }
    if (ensureFailuresRemaining > 0) {
      ensureFailuresRemaining -= 1;
      throw new Error('fixture config write failed');
    }
    activeRuntimeAccounts.add(String(opts.runtimeAccountId));
    return { changed: true };
  },
  async removeHostedChannelAccount(opts: Record<string, unknown>) {
    removeCalls.push(opts);
    if (removePause) {
      removeEntered?.();
      await removePause;
    }
    activeRuntimeAccounts.delete(String(opts.runtimeAccountId));
    return { changed: true };
  },
};

const providerClient: ChannelProviderClientLike = {
  async validate(channel, token) {
    if (providerValidationPause) {
      providerValidationEntered?.();
      await providerValidationPause;
    }
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

let xPostMode: 'ok' | 'revoked' | 'rate_limited' = 'ok';
const xPostCalls: string[] = [];
const xClient: XUserClientLike = {
  async validate() {
    return {
      ok: true,
      value: { id: '2244994945', username: 'eden_fixture', name: 'Eden Fixture' },
    };
  },
  async post(_credentials, text) {
    xPostCalls.push(text);
    if (xPostMode === 'ok') return { ok: true, value: { id: '1900000000000000000' } };
    if (xPostMode === 'revoked') {
      return {
        ok: false,
        code: 'revoked',
        message: 'X rejected the saved access token. Replace or revoke it.',
        retryable: false,
      };
    }
    return {
      ok: false,
      code: 'rate_limited',
      message: 'X rate-limited this account. Wait for the limit to reset.',
      retryable: true,
      retryAfterSeconds: 17,
    };
  },
};

const managedBotToken = '987654321:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd';
const telegramManagedBotApi: TelegramManagedBotApiClientLike = {
  getManagedBotToken: vi.fn(async () => managedBotToken),
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

async function runtimeCoordinates(connectionId: string): Promise<{
  agentId: string;
  bindingId: string;
}> {
  const rows = await pg<Array<{ agent_id: string; binding_id: string | null }>>`
    select a.openclaw_id as agent_id, c.metadata ->> '_runtimeBindingId' as binding_id
    from channel_connections c
    join agents a on a.account_id = c.agent_id
    where c.id = ${connectionId} and c.desired_state = 'active'
  `;
  expect(rows[0]?.binding_id).toMatch(/^[0-9a-f-]{36}$/);
  return { agentId: rows[0]!.agent_id, bindingId: rows[0]!.binding_id! };
}

async function resolvesWithin(promise: Promise<unknown>, timeoutMs = 2_000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

beforeAll(async () => {
  ownerId = await insertUserAccount(`${marker}_owner`);
  strangerId = await insertUserAccount(`${marker}_stranger`);
  adminId = await insertUserAccount(`${marker}_admin`);
  firstAgentUsername = `${marker}-first`;
  secondAgentUsername = `${marker}-second`;
  firstAgentId = await insertAgentAccount(firstAgentUsername, {
    ownerId,
    public: true,
    openclawId: firstAgentUsername,
    provisionStatus: 'ready',
  });
  secondAgentId = await insertAgentAccount(secondAgentUsername, {
    ownerId,
    public: true,
    openclawId: secondAgentUsername,
    provisionStatus: 'ready',
  });
  adminAgentUsername = `${marker}-admin-agent`;
  await insertAgentAccount(adminAgentUsername, {
    ownerId: adminId,
    public: true,
    openclawId: adminAgentUsername,
    provisionStatus: 'ready',
  });
  app = await buildServer({
    auth: { provider: new DevAuthProvider({ adminUsernames: [`${marker}_admin`] }) },
    gateway: null,
    channels: {
      vault,
      channelSync: fakeChannelSync,
      providerClient,
      sessionSync,
      turnMetering,
      runtimeToken,
      xConnector: new XByoConnectorService(
        xClient,
        new PostgresChannelCredentialCustody(vault),
      ),
      telegramManager: {
        username: 'eden_manager_bot',
        webhookSecret: 'synthetic-telegram-webhook-secret',
        botApiClient: telegramManagedBotApi,
      },
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
  it('stores only AES ciphertext, exposes no token-derived preview, and audits storage', async () => {
    const token = `valid_${marker}_secret_zxqv`;
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
      bot: { username: 'discord_fixture_bot' },
    });
    expect(connection).not.toHaveProperty('tokenPreview');

    const rows = await pg<
      Array<{
        token_ciphertext: string;
        token_iv: string;
        token_auth_tag: string;
        token_sha256: string;
        key_version: string;
        metadata: Record<string, unknown>;
      }>
    >`
      select token_ciphertext, token_iv, token_auth_tag, token_sha256, key_version, metadata
      from channel_connections where id = ${connection.id}
    `;
    expect(JSON.stringify(rows[0])).not.toContain(token);
    expect(JSON.stringify(rows[0]?.metadata)).not.toContain(token.slice(-4));
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
    const storedAudits = await pg<{ metadata: Record<string, unknown> }[]>`
      select metadata from secret_access_audit_events where secret_id = ${connection.id}
    `;
    expect(JSON.stringify(storedAudits)).not.toContain(token);
    expect(JSON.stringify(storedAudits)).not.toContain(token.slice(-4));
  });

  it('retains an invalid token as a clear error and rotates it safely on retry', async () => {
    const connection = await createConnection({ token: `bad_${marker}_9999` });
    expect(connection.observedState).toBe('error');
    expect(connection.lastError).toMatchObject({ code: 'invalid_token' });

    const retried = await app.inject({
      method: 'POST',
      url: `/channels/connections/${connection.id}/retry`,
      headers: { cookie: devCookie(ownerId) },
      payload: { token: `valid_${marker}_replacement_wxyz` },
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({
      ok: true,
      connection: { observedState: 'verified', lastError: null },
    });
    expect(retried.json().connection).not.toHaveProperty('tokenPreview');
    expect(retried.body).not.toContain(`valid_${marker}_replacement_wxyz`);
    const [rotated] = await pg<{ metadata: Record<string, unknown> }[]>`
      select metadata from channel_connections where id = ${connection.id}
    `;
    expect(JSON.stringify(rotated?.metadata)).not.toContain('wxyz');
    const rotationAudits = await pg<{ metadata: Record<string, unknown> }[]>`
      select metadata from secret_access_audit_events where secret_id = ${connection.id}
    `;
    expect(JSON.stringify(rotationAudits)).not.toContain('wxyz');
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

describe('X BYO-app custody and posting', () => {
  it('vaults all four credentials, exposes only identity metadata, posts, and revokes', async () => {
    const credentials = {
      apiKey: `x-api-key-${marker}`,
      apiSecret: `x-api-secret-${marker}`,
      accessToken: `x-access-token-${marker}`,
      accessTokenSecret: `x-access-secret-${marker}`,
    };
    const connected = await app.inject({
      method: 'POST',
      url: '/channels/x/connections',
      headers: { cookie: devCookie(ownerId) },
      payload: { credentials, agentUsername: firstAgentUsername, label: 'X fixture' },
    });
    expect(connected.statusCode).toBe(201);
    expect(connected.json().connection).toMatchObject({
      accountId: ownerId,
      agentId: firstAgentId,
      channel: 'x',
      status: 'active',
      user: { id: '2244994945', username: 'eden_fixture', name: 'Eden Fixture' },
    });
    expect(connected.json().connection).not.toHaveProperty('tokenPreview');
    for (const secret of Object.values(credentials)) expect(connected.body).not.toContain(secret);
    const connectionId = connected.json().connection.id as string;

    const stored = await pg<Array<{
      token_ciphertext: string;
      metadata: Record<string, unknown>;
    }>>`
      select token_ciphertext, metadata
      from channel_connections where id = ${connectionId}
    `;
    expect(stored[0]?.token_ciphertext).not.toContain(marker);
    for (const secret of Object.values(credentials)) {
      expect(JSON.stringify(stored[0]?.metadata)).not.toContain(secret);
      expect(JSON.stringify(stored[0]?.metadata)).not.toContain(secret.slice(-4));
    }
    expect(JSON.stringify(stored[0]?.metadata)).not.toContain('apiSecret');
    const xAudits = await pg<{ metadata: Record<string, unknown> }[]>`
      select metadata from secret_access_audit_events where secret_id = ${connectionId}
    `;
    for (const secret of Object.values(credentials)) {
      expect(JSON.stringify(xAudits)).not.toContain(secret);
      expect(JSON.stringify(xAudits)).not.toContain(secret.slice(-4));
    }

    const decryptSpy = vi.spyOn(vault, 'decrypt');
    const validateSpy = vi.spyOn(providerClient, 'validate');
    const discoverSpy = vi.spyOn(providerClient, 'discoverDestinations');
    const ensureBeforeGeneric = ensureCalls.length;
    const removeBeforeGeneric = removeCalls.length;
    try {
      const genericAttempts = await Promise.all([
        app.inject({ method: 'POST', url: `/channels/connections/${connectionId}/retry`, headers: { cookie: devCookie(ownerId) }, payload: {} }),
        app.inject({ method: 'GET', url: `/channels/connections/${connectionId}/destinations`, headers: { cookie: devCookie(ownerId) } }),
        app.inject({ method: 'POST', url: `/channels/connections/${connectionId}/activate`, headers: { cookie: devCookie(ownerId) }, payload: {} }),
        app.inject({ method: 'POST', url: `/channels/connections/${connectionId}/deactivate`, headers: { cookie: devCookie(ownerId) }, payload: {} }),
        app.inject({ method: 'DELETE', url: `/channels/connections/${connectionId}`, headers: { cookie: devCookie(ownerId) } }),
        app.inject({ method: 'GET', url: `/channels/connections/${connectionId}/pairing`, headers: { cookie: devCookie(ownerId) } }),
      ]);
      expect(genericAttempts.map((response) => response.statusCode)).toEqual(
        Array(genericAttempts.length).fill(404),
      );
      expect(decryptSpy).not.toHaveBeenCalled();
      expect(validateSpy).not.toHaveBeenCalled();
      expect(discoverSpy).not.toHaveBeenCalled();
      expect(ensureCalls).toHaveLength(ensureBeforeGeneric);
      expect(removeCalls).toHaveLength(removeBeforeGeneric);
      const untouched = await pg<{ desired_state: string; channel: string }[]>`
        select desired_state, channel from channel_connections where id = ${connectionId}
      `;
      expect(untouched).toEqual([{ desired_state: 'active', channel: 'x' }]);
    } finally {
      decryptSpy.mockRestore();
      validateSpy.mockRestore();
      discoverSpy.mockRestore();
    }

    const auditsBeforeAdmin = await pg<{ count: number }[]>`
      select count(*)::int as count from secret_access_audit_events
      where secret_id = ${connectionId}
    `;
    const postCallsBeforeAdmin = xPostCalls.length;
    const adminPost = await app.inject({
      method: 'POST',
      url: `/channels/x/connections/${connectionId}/posts`,
      headers: { cookie: devCookie(adminId) },
      payload: { text: 'admin must not post through owner custody' },
    });
    const adminRevoke = await app.inject({
      method: 'POST',
      url: `/channels/x/connections/${connectionId}/revoke`,
      headers: { cookie: devCookie(adminId) },
      payload: {},
    });
    expect(adminPost.statusCode).toBe(404);
    expect(adminRevoke.statusCode).toBe(404);
    expect(xPostCalls).toHaveLength(postCallsBeforeAdmin);
    const auditsAfterAdmin = await pg<{ count: number }[]>`
      select count(*)::int as count from secret_access_audit_events
      where secret_id = ${connectionId}
    `;
    expect(auditsAfterAdmin[0]?.count).toBe(auditsBeforeAdmin[0]?.count);
    const stillActive = await pg<{ desired_state: string }[]>`
      select desired_state from channel_connections where id = ${connectionId}
    `;
    expect(stillActive[0]?.desired_state).toBe('active');

    xPostMode = 'ok';
    const posted = await app.inject({
      method: 'POST',
      url: `/channels/x/connections/${connectionId}/posts`,
      headers: { cookie: devCookie(ownerId) },
      payload: { text: 'deterministic X connector proof' },
    });
    expect(posted.statusCode).toBe(201);
    expect(posted.json()).toEqual({ ok: true, post: { id: '1900000000000000000' } });

    const strangerPost = await app.inject({
      method: 'POST',
      url: `/channels/x/connections/${connectionId}/posts`,
      headers: { cookie: devCookie(strangerId) },
      payload: { text: 'must not post' },
    });
    expect(strangerPost.statusCode).toBe(404);

    const revoked = await app.inject({
      method: 'POST',
      url: `/channels/x/connections/${connectionId}/revoke`,
      headers: { cookie: devCookie(ownerId) },
      payload: {},
    });
    expect(revoked.statusCode).toBe(200);
    const deniedAfterRevoke = await app.inject({
      method: 'POST',
      url: `/channels/x/connections/${connectionId}/posts`,
      headers: { cookie: devCookie(ownerId) },
      payload: { text: 'must remain revoked' },
    });
    expect(deniedAfterRevoke.statusCode).toBe(404);
  });

  it('surfaces revoked and rate-limited posting states without exposing credentials', async () => {
    const connect = async (suffix: string) => {
      const response = await app.inject({
        method: 'POST',
        url: '/channels/x/connections',
        headers: { cookie: devCookie(ownerId) },
        payload: {
          credentials: {
            apiKey: `key-${marker}-${suffix}`,
            apiSecret: `secret-${marker}-${suffix}`,
            accessToken: `token-${marker}-${suffix}`,
            accessTokenSecret: `token-secret-${marker}-${suffix}`,
          },
        },
      });
      expect(response.statusCode).toBe(201);
      return response.json().connection.id as string;
    };

    const revokedId = await connect('revoked');
    xPostMode = 'revoked';
    const revoked = await app.inject({
      method: 'POST',
      url: `/channels/x/connections/${revokedId}/posts`,
      headers: { cookie: devCookie(ownerId) },
      payload: { text: 'revoked case' },
    });
    expect(revoked.statusCode).toBe(409);
    expect(revoked.json()).toMatchObject({ error: { code: 'revoked' } });
    expect(revoked.body).not.toContain(marker);

    const limitedId = await connect('limited');
    xPostMode = 'rate_limited';
    const limited = await app.inject({
      method: 'POST',
      url: `/channels/x/connections/${limitedId}/posts`,
      headers: { cookie: devCookie(ownerId) },
      payload: { text: 'limited case' },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: 'rate_limited' } });
  });
});

describe('Telegram Managed Bots onboarding', () => {
  it('binds the Telegram owner through a one-time nonce, stores atomically, and attaches an owned agent', async () => {
    const setup = await app.inject({
      method: 'POST',
      url: '/channels/telegram/managed-bots/onboarding',
      headers: { cookie: devCookie(ownerId) },
      payload: { suggestedBotUsername: 'edenfixturebot' },
    });
    expect(setup.statusCode).toBe(201);
    const created = setup.json() as {
      intent: { id: string; state: string };
      ownerBindingUrl: string;
    };
    expect(created.intent.state).toBe('pending_owner');
    const nonce = new URL(created.ownerBindingUrl).searchParams.get('start');
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const rawIntent = await pg<Array<{
      intent_secret_hash: string;
      provider_owner_id_hash: string | null;
    }>>`
      select intent_secret_hash, provider_owner_id_hash
      from channel_onboarding_intents where id = ${created.intent.id}
    `;
    expect(rawIntent[0]?.intent_secret_hash).not.toBe(nonce);
    expect(rawIntent[0]?.provider_owner_id_hash).toBeNull();

    const unauthorized = await app.inject({
      method: 'POST',
      url: '/channels/telegram/managed-bots/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'wrong-secret' },
      payload: { message: { text: `/start ${nonce}`, from: { id: 42424242 } } },
    });
    expect(unauthorized.statusCode).toBe(401);

    const bound = await app.inject({
      method: 'POST',
      url: '/channels/telegram/managed-bots/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'synthetic-telegram-webhook-secret' },
      payload: { message: { text: `/start ${nonce}`, from: { id: 42424242 } } },
    });
    expect(bound.statusCode).toBe(200);
    expect(bound.json()).toEqual({ ok: true, accepted: true });

    const awaiting = await app.inject({
      method: 'GET',
      url: `/channels/telegram/managed-bots/onboarding/${created.intent.id}`,
      headers: { cookie: devCookie(ownerId) },
    });
    expect(awaiting.statusCode).toBe(200);
    expect(awaiting.json()).toMatchObject({
      intent: { state: 'awaiting_bot' },
      managedBotUrl: expect.stringContaining('https://t.me/newbot/eden_manager_bot/edenfixturebot'),
      connection: null,
    });

    const managedUpdate = {
      managed_bot: {
        user: { id: 42424242, first_name: 'Telegram', last_name: 'Owner', username: 'owner_name' },
        bot: { id: 52525252, is_bot: true, first_name: 'Eden', last_name: 'Managed', username: 'edenfixturebot' },
      },
    };
    const stored = await app.inject({
      method: 'POST',
      url: '/channels/telegram/managed-bots/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'synthetic-telegram-webhook-secret' },
      payload: managedUpdate,
    });
    expect(stored.statusCode).toBe(200);
    expect(stored.json()).toEqual({ ok: true, accepted: true });

    const completed = await app.inject({
      method: 'GET',
      url: `/channels/telegram/managed-bots/onboarding/${created.intent.id}`,
      headers: { cookie: devCookie(ownerId) },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({
      intent: { state: 'stored', lastErrorCode: null },
      managedBotUrl: null,
      connection: {
        channel: 'telegram',
        desiredState: 'inactive',
        observedState: 'verified',
        bot: { username: 'edenfixturebot' },
      },
    });
    expect(completed.body).not.toContain(managedBotToken);
    expect(completed.body).not.toContain('42424242');
    expect(completed.json().connection).not.toHaveProperty('tokenPreview');
    const connectionId = completed.json().connection.id as string;

    const persisted = await pg<Array<{
      token_ciphertext: string;
      metadata: Record<string, unknown>;
    }>>`
      select token_ciphertext, metadata
      from channel_connections where id = ${connectionId}
    `;
    expect(persisted[0]?.token_ciphertext).not.toContain(managedBotToken);
    expect(JSON.stringify(persisted[0]?.metadata)).not.toContain(managedBotToken);
    expect(JSON.stringify(persisted[0]?.metadata)).not.toContain(managedBotToken.slice(-4));
    expect(JSON.stringify(persisted[0]?.metadata)).not.toContain('42424242');
    const telegramAudits = await pg<{ metadata: Record<string, unknown> }[]>`
      select metadata from secret_access_audit_events where secret_id = ${connectionId}
    `;
    expect(JSON.stringify(telegramAudits)).not.toContain(managedBotToken);
    expect(JSON.stringify(telegramAudits)).not.toContain(managedBotToken.slice(-4));

    const managedAuditsBeforeAdmin = await pg<{ count: number }[]>`
      select count(*)::int as count from secret_access_audit_events
      where secret_id = ${connectionId}
    `;
    for (const request of [
      { method: 'POST', url: `/channels/connections/${connectionId}/retry`, payload: {} },
      { method: 'GET', url: `/channels/connections/${connectionId}/destinations` },
      { method: 'POST', url: `/channels/connections/${connectionId}/activate`, payload: {} },
      { method: 'POST', url: `/channels/connections/${connectionId}/deactivate`, payload: {} },
      { method: 'DELETE', url: `/channels/connections/${connectionId}` },
    ] as const) {
      const response = await app.inject({
        method: request.method,
        url: request.url,
        headers: { cookie: devCookie(adminId) },
        ...('payload' in request ? { payload: request.payload } : {}),
      });
      expect(response.statusCode).toBe(404);
    }
    const managedAuditsAfterAdmin = await pg<{ count: number }[]>`
      select count(*)::int as count from secret_access_audit_events
      where secret_id = ${connectionId}
    `;
    expect(managedAuditsAfterAdmin[0]?.count).toBe(managedAuditsBeforeAdmin[0]?.count);
    const stillStored = await pg<{ desired_state: string; agent_id: string | null }[]>`
      select desired_state, agent_id from channel_connections where id = ${connectionId}
    `;
    expect(stillStored[0]).toEqual({ desired_state: 'inactive', agent_id: null });

    const adminAttach = await app.inject({
      method: 'POST',
      url: `/channels/telegram/managed-bots/onboarding/${created.intent.id}/attach`,
      headers: { cookie: devCookie(adminId) },
      payload: { agentUsername: adminAgentUsername },
    });
    expect(adminAttach.statusCode).toBe(404);
    const unattached = await pg<{ agent_id: string | null }[]>`
      select agent_id from channel_connections where id = ${connectionId}
    `;
    expect(unattached[0]?.agent_id).toBeNull();

    const attached = await app.inject({
      method: 'POST',
      url: `/channels/telegram/managed-bots/onboarding/${created.intent.id}/attach`,
      headers: { cookie: devCookie(ownerId) },
      payload: { agentUsername: firstAgentUsername, label: 'Managed fixture' },
    });
    expect(attached.statusCode).toBe(200);
    expect(attached.json().connection).toMatchObject({ agentId: firstAgentId, label: 'Managed fixture' });

    const activated = await app.inject({
      method: 'POST',
      url: `/channels/connections/${connectionId}/activate`,
      headers: { cookie: devCookie(ownerId) },
      payload: { dmPolicy: 'pairing', allowFrom: [], discordGuilds: [], telegramGroups: [] },
    });
    expect(activated.statusCode).toBe(200);
    const callsBeforeReattach = ensureCalls.length;
    const activeReattach = await app.inject({
      method: 'POST',
      url: `/channels/telegram/managed-bots/onboarding/${created.intent.id}/attach`,
      headers: { cookie: devCookie(ownerId) },
      payload: { agentUsername: secondAgentUsername },
    });
    expect(activeReattach.statusCode).toBe(409);
    expect(activeReattach.json()).toMatchObject({
      error: { code: 'telegram_managed_bot_active' },
    });
    expect(ensureCalls).toHaveLength(callsBeforeReattach);
    const stillBound = await pg<
      Array<{ desired_state: string; agent_id: string | null; runtime_account_id: string | null }>
    >`
      select desired_state, agent_id, runtime_account_id
      from channel_connections where id = ${connectionId}
    `;
    expect(stillBound[0]).toEqual({
      desired_state: 'active',
      agent_id: firstAgentId,
      runtime_account_id: expect.any(String),
    });

    const replay = await app.inject({
      method: 'POST',
      url: '/channels/telegram/managed-bots/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'synthetic-telegram-webhook-secret' },
      payload: managedUpdate,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ ok: true, accepted: false });

    const crossAccount = await app.inject({
      method: 'GET',
      url: `/channels/telegram/managed-bots/onboarding/${created.intent.id}`,
      headers: { cookie: devCookie(strangerId) },
    });
    expect(crossAccount.statusCode).toBe(404);
  });

  it('rolls back the managed credential and intent when custody mints a wrong-scope capability', async () => {
    const intentId = randomUUID();
    await pg`
      insert into channel_onboarding_intents (
        id, account_id, channel, intent_secret_hash, state, expires_at
      ) values (
        ${intentId}, ${ownerId}, 'telegram',
        ${createHash('sha256').update(`intent-${intentId}`).digest('hex')},
        'pending_owner', now() + interval '15 minutes'
      )
    `;
    await pg`
      update channel_onboarding_intents
      set provider_owner_id_hash = ${createHash('sha256').update(`owner-${intentId}`).digest('hex')},
          state = 'awaiting_bot'
      where id = ${intentId}
    `;
    await pg`update channel_onboarding_intents set state = 'exchanging' where id = ${intentId}`;
    const capKey = randomBytes(32);
    const custody = new PostgresTelegramManagedBotCustody(
      { id: intentId, accountId: ownerId },
      vault,
      capKey,
      (scope, key) => hostedChannelSecretRef({ ...scope, runtimeAccountId: `${scope.runtimeAccountId}-wrong` }, key),
    );
    const token = `765432109:${randomBytes(24).toString('base64url')}`;
    await expect(
      custody.storeManagedBotToken({
        ownerAccountId: ownerId,
        channel: 'telegram',
        plaintextToken: token,
        owner: { id: '42424243', username: 'scope_owner', displayName: 'Scope Owner' },
        bot: { id: '52525253', username: 'scopefixturebot', displayName: 'Scope Fixture' },
      }),
    ).rejects.toThrow('invalid secret scope');
    const intents = await pg<{ state: string; connection_id: string | null }[]>`
      select state, connection_id from channel_onboarding_intents where id = ${intentId}
    `;
    expect(intents[0]).toEqual({ state: 'exchanging', connection_id: null });
    const orphan = await pg<{ count: number }[]>`
      select count(*)::int as count from channel_connections
      where channel = 'telegram' and token_sha256 = ${createHash('sha256').update(token).digest('hex')}
    `;
    expect(orphan[0]?.count).toBe(0);
  });
});

describe('named-account lifecycle', () => {
  it('fences stale runtime callbacks across activation and token rotation', async () => {
    const connection = await createConnection({
      token: `valid_${marker}_binding_generation_a`,
      agentUsername: firstAgentUsername,
    });
    const activated = await app.inject({
      method: 'POST',
      url: `/channels/connections/${connection.id}/activate`,
      headers: { cookie: devCookie(ownerId) },
      payload: { dmPolicy: 'pairing', allowFrom: [], discordGuilds: [], telegramGroups: [] },
    });
    expect(activated.statusCode).toBe(200);
    const readBinding = async () => {
      const rows = await pg<Array<{ binding_id: string | null }>>`
        select metadata ->> '_runtimeBindingId' as binding_id
        from channel_connections where id = ${connection.id}
      `;
      return rows[0]!.binding_id!;
    };
    const firstBinding = await readBinding();
    expect(firstBinding).toMatch(/^[0-9a-f-]{36}$/);
    const runtimeHeaders = { authorization: `Bearer ${runtimeToken}` };
    const messagePayload = {
      connectionId: connection.id,
      runtimeAccountId: connection.runtimeAccountId,
      agentId: firstAgentUsername,
      bindingId: firstBinding,
      gatewaySessionKey: `agent:${firstAgentUsername}:discord:${connection.runtimeAccountId}:direct:44556677`,
      conversationId: '44556677',
      conversationScope: 'direct',
      peerId: '44556677',
      externalMessageId: `${marker}:binding-message`,
      role: 'user',
      content: 'binding proof',
      createdAt: new Date().toISOString(),
    };
    const sessionCalls = sessionSync.syncMessage.mock.calls.length;
    const reserveCalls = turnMetering.reserve.mock.calls.length;
    for (const payload of [
      { ...messagePayload, agentId: undefined, bindingId: undefined },
      { ...messagePayload, agentId: secondAgentUsername },
      { ...messagePayload, bindingId: randomUUID() },
    ]) {
      const denied = await app.inject({
        method: 'POST',
        url: '/channels/runtime/messages',
        headers: runtimeHeaders,
        payload,
      });
      expect(denied.statusCode).toBe(404);
    }
    expect(sessionSync.syncMessage).toHaveBeenCalledTimes(sessionCalls);
    const staleReserve = await app.inject({
      method: 'POST',
      url: '/channels/runtime/turns/reserve',
      headers: runtimeHeaders,
      payload: {
        turnId: randomUUID(),
        connectionId: connection.id,
        runtimeAccountId: connection.runtimeAccountId,
        agentId: firstAgentUsername,
        bindingId: randomUUID(),
      },
    });
    expect(staleReserve.statusCode).toBe(404);
    expect(turnMetering.reserve).toHaveBeenCalledTimes(reserveCalls);

    const rotated = await app.inject({
      method: 'POST',
      url: `/channels/connections/${connection.id}/retry`,
      headers: { cookie: devCookie(ownerId) },
      payload: { token: `valid_${marker}_binding_generation_b` },
    });
    expect(rotated.statusCode).toBe(200);
    const secondBinding = await readBinding();
    expect(secondBinding).not.toBe(firstBinding);
    const staleStatus = await app.inject({
      method: 'POST',
      url: '/channels/runtime/status',
      headers: runtimeHeaders,
      payload: {
        connectionId: connection.id,
        runtimeAccountId: connection.runtimeAccountId,
        agentId: firstAgentUsername,
        bindingId: firstBinding,
        state: 'live',
      },
    });
    const stalePairing = await app.inject({
      method: 'POST',
      url: '/channels/runtime/pairing',
      headers: runtimeHeaders,
      payload: {
        connectionId: connection.id,
        runtimeAccountId: connection.runtimeAccountId,
        agentId: firstAgentUsername,
        bindingId: firstBinding,
        peerId: '44556677',
        code: 'stale-code',
      },
    });
    expect(staleStatus.statusCode).toBe(404);
    expect(stalePairing.statusCode).toBe(404);
    const pairingRows = await pg<{ count: number }[]>`
      select count(*)::int as count from channel_pairing_requests
      where connection_id = ${connection.id}
    `;
    expect(pairingRows[0]?.count).toBe(0);
  });

  it('rejects activation when the attached agent changes during provider validation', async () => {
    const connection = await createConnection({
      token: `valid_${marker}_activation_agent_race`,
      agentUsername: firstAgentUsername,
    });
    let releaseValidation!: () => void;
    let signalEntered!: () => void;
    providerValidationPause = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    providerValidationEntered = signalEntered;
    const callsBefore = ensureCalls.length;
    const activation = app.inject({
      method: 'POST',
      url: `/channels/connections/${connection.id}/activate`,
      headers: { cookie: devCookie(ownerId) },
      payload: { dmPolicy: 'pairing', allowFrom: [], discordGuilds: [], telegramGroups: [] },
    });
    await entered;
    await pg`
      update channel_connections
      set agent_id = ${secondAgentId}, updated_at = now()
      where id = ${connection.id} and desired_state = 'inactive'
    `;
    releaseValidation();
    providerValidationPause = null;
    providerValidationEntered = null;
    const denied = await activation;
    expect(denied.statusCode).toBe(409);
    expect(denied.json()).toMatchObject({ error: { code: 'channel_connection_changed' } });
    expect(ensureCalls).toHaveLength(callsBefore);
    const persisted = await pg<
      Array<{ desired_state: string; agent_id: string | null }>
    >`
      select desired_state, agent_id from channel_connections where id = ${connection.id}
    `;
    expect(persisted[0]).toEqual({ desired_state: 'inactive', agent_id: secondAgentId });
  });

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
      expect(response.body).toContain('group delivery requires at least one allowlisted sender id');
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
    const runtime = await runtimeCoordinates(connection.id);
    const stopped = await app.inject({
      method: 'POST',
      url: '/channels/runtime/status',
      headers: { authorization: `Bearer ${runtimeToken}` },
      payload: {
        connectionId: connection.id,
        runtimeAccountId: connection.runtimeAccountId,
        ...runtime,
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

    const lostAck = await app.inject({
      method: 'POST',
      url: '/channels/runtime/status',
      headers: { authorization: `Bearer ${runtimeToken}` },
      payload: {
        connectionId: connection.id,
        runtimeAccountId: connection.runtimeAccountId,
        ...runtime,
        state: 'error',
        errorCode: 'delivery_ack_lost',
      },
    });
    expect(lostAck.statusCode).toBe(200);
    const loud = await pg<
      Array<{
        desired_state: string;
        observed_state: string;
        status: string;
        last_error_code: string | null;
      }>
    >`
      select desired_state, observed_state, status, last_error_code
      from channel_connections
      where id = ${connection.id}
    `;
    expect(loud[0]).toEqual({
      desired_state: 'active',
      observed_state: 'error',
      status: 'error',
      last_error_code: 'delivery_ack_lost',
    });

    const liveAgain = await app.inject({
      method: 'POST',
      url: '/channels/runtime/status',
      headers: { authorization: `Bearer ${runtimeToken}` },
      payload: {
        connectionId: connection.id,
        runtimeAccountId: connection.runtimeAccountId,
        ...runtime,
        state: 'live',
      },
    });
    expect(liveAgain.statusCode).toBe(200);
    const preserved = await pg<
      Array<{
        desired_state: string;
        observed_state: string;
        status: string;
        last_error_code: string | null;
      }>
    >`
      select desired_state, observed_state, status, last_error_code
      from channel_connections
      where id = ${connection.id}
    `;
    expect(preserved[0]).toEqual({
      desired_state: 'active',
      observed_state: 'live',
      status: 'connected',
      last_error_code: 'delivery_ack_lost',
    });
  });

  it('revokes fatal runtime status before awaiting hosted-config cleanup', async () => {
    const connection = await createConnection({
      token: `valid_${marker}_fatal_status_order`,
      agentUsername: firstAgentUsername,
    });
    const activated = await app.inject({
      method: 'POST',
      url: `/channels/connections/${connection.id}/activate`,
      headers: { cookie: devCookie(ownerId) },
      payload: { dmPolicy: 'pairing', allowFrom: [], discordGuilds: [] },
    });
    expect(activated.statusCode).toBe(200);
    const runtime = await runtimeCoordinates(connection.id);
    let releaseRemove!: () => void;
    let signalRemoveEntered!: () => void;
    removePause = new Promise<void>((resolve) => {
      releaseRemove = resolve;
    });
    const removeWasEntered = new Promise<void>((resolve) => {
      signalRemoveEntered = resolve;
    });
    removeEntered = signalRemoveEntered;
    const status = app.inject({
      method: 'POST',
      url: '/channels/runtime/status',
      headers: { authorization: `Bearer ${runtimeToken}` },
      payload: {
        connectionId: connection.id,
        runtimeAccountId: connection.runtimeAccountId,
        ...runtime,
        state: 'error',
        errorCode: 'invalid_token',
      },
    });
    expect(await resolvesWithin(removeWasEntered)).toBe(true);
    const sessionCalls = sessionSync.syncMessage.mock.calls.length;
    const reserveCalls = turnMetering.reserve.mock.calls.length;
    try {
      const state = await pg<{ desired_state: string }[]>`
        select desired_state from channel_connections where id = ${connection.id}
      `;
      expect(state).toEqual([{ desired_state: 'inactive' }]);
      const message = await app.inject({
        method: 'POST',
        url: '/channels/runtime/messages',
        headers: { authorization: `Bearer ${runtimeToken}` },
        payload: {
          connectionId: connection.id,
          runtimeAccountId: connection.runtimeAccountId,
          ...runtime,
          gatewaySessionKey: `agent:${marker}:discord:${connection.runtimeAccountId}:direct:987654`,
          peerId: '987654',
          externalMessageId: `${marker}:fatal-status-message`,
          role: 'user',
          content: 'must be revoked before cleanup',
          createdAt: new Date().toISOString(),
        },
      });
      const reserve = await app.inject({
        method: 'POST',
        url: '/channels/runtime/turns/reserve',
        headers: { authorization: `Bearer ${runtimeToken}` },
        payload: {
          turnId: randomUUID(),
          connectionId: connection.id,
          runtimeAccountId: connection.runtimeAccountId,
          ...runtime,
        },
      });
      expect(message.statusCode).toBe(404);
      expect(reserve.statusCode).toBe(404);
      expect(sessionSync.syncMessage).toHaveBeenCalledTimes(sessionCalls);
      expect(turnMetering.reserve).toHaveBeenCalledTimes(reserveCalls);
    } finally {
      releaseRemove();
      removePause = null;
      removeEntered = null;
    }
    expect((await status).statusCode).toBe(200);
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
        ...(await runtimeCoordinates(connection.id)),
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
        ...(await runtimeCoordinates(connection.id)),
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

  it('resumes an approved pairing marker after a crash before runtime config application', async () => {
    const connection = await activePairingConnection('pairing_resume');
    const peerId = '77449955';
    const paired = await app.inject({
      method: 'POST',
      url: '/channels/runtime/pairing',
      headers: { authorization: `Bearer ${runtimeToken}` },
      payload: {
        connectionId: connection.id,
        runtimeAccountId: connection.runtimeAccountId,
        ...(await runtimeCoordinates(connection.id)),
        peerId,
        code: 'EDEN-3311',
      },
    });
    const requestId = (paired.json() as { requestId: string }).requestId;
    const marker = { requestId, nonce: randomUUID() };
    await pg.begin(async (tx) => {
      const connectionRows = await tx<{ metadata: unknown }[]>`
        select metadata from channel_connections where id = ${connection.id} for update
      `;
      const requestRows = await tx<{ metadata: unknown }[]>`
        select metadata from channel_pairing_requests where id = ${requestId} for update
      `;
      const connectionMetadata = connectionRows[0]?.metadata as Record<string, unknown>;
      const config = connectionMetadata.config as Record<string, unknown>;
      await tx`
        update channel_connections
        set metadata = ${tx.json(JSON.stringify({
          ...connectionMetadata,
          config: { ...config, allowFrom: [peerId] },
          _pairingDecision: marker,
        }))}
        where id = ${connection.id}
      `;
      await tx`
        update channel_pairing_requests
        set status = 'approved', decided_at = now(), decided_by_account_id = ${ownerId},
            metadata = ${tx.json(JSON.stringify({
              ...(requestRows[0]?.metadata as Record<string, unknown>),
              _decisionNonce: marker.nonce,
            }))}
        where id = ${requestId}
      `;
    });

    const callsBefore = ensureCalls.length;
    const resumed = await app.inject({
      method: 'POST',
      url: `/channels/connections/${connection.id}/pairing/${requestId}/approve`,
      headers: { cookie: devCookie(ownerId) },
      payload: {},
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toEqual({ ok: true, linkedToMyAccount: false });
    expect(ensureCalls).toHaveLength(callsBefore + 1);
    expect(ensureCalls.at(-1)).toMatchObject({ allowFrom: [peerId] });

    const rows = await pg<Array<{ connection_metadata: unknown; request_metadata: unknown }>>`
      select c.metadata as connection_metadata, p.metadata as request_metadata
      from channel_pairing_requests p
      join channel_connections c on c.id = p.connection_id
      where p.id = ${requestId}
    `;
    expect(JSON.stringify(rows[0]?.connection_metadata)).not.toContain('_pairingDecision');
    expect(JSON.stringify(rows[0]?.request_metadata)).not.toContain('_decisionNonce');
    expect(JSON.stringify(rows[0]?.request_metadata)).not.toContain('pairingCode');
  });

  it('serializes duplicate pairing resume so stale cleanup cannot remove the winner', async () => {
    const connection = await activePairingConnection('pairing_resume_deactivate');
    const peerId = '77449966';
    const paired = await app.inject({
      method: 'POST',
      url: '/channels/runtime/pairing',
      headers: { authorization: `Bearer ${runtimeToken}` },
      payload: {
        connectionId: connection.id,
        runtimeAccountId: connection.runtimeAccountId,
        ...(await runtimeCoordinates(connection.id)),
        peerId,
        code: 'EDEN-5511',
      },
    });
    const requestId = (paired.json() as { requestId: string }).requestId;
    const marker = { requestId, nonce: randomUUID() };
    await pg.begin(async (tx) => {
      const connectionRows = await tx<{ metadata: unknown }[]>`
        select metadata from channel_connections where id = ${connection.id} for update
      `;
      const requestRows = await tx<{ metadata: unknown }[]>`
        select metadata from channel_pairing_requests where id = ${requestId} for update
      `;
      const connectionMetadata = connectionRows[0]?.metadata as Record<string, unknown>;
      const config = connectionMetadata.config as Record<string, unknown>;
      await tx`
        update channel_connections
        set metadata = ${tx.json(JSON.stringify({
          ...connectionMetadata,
          config: { ...config, allowFrom: [peerId] },
          _pairingDecision: marker,
        }))}
        where id = ${connection.id}
      `;
      await tx`
        update channel_pairing_requests
        set status = 'approved', decided_at = now(), decided_by_account_id = ${ownerId},
            metadata = ${tx.json(JSON.stringify({
              ...(requestRows[0]?.metadata as Record<string, unknown>),
              _decisionNonce: marker.nonce,
            }))}
        where id = ${requestId}
      `;
    });

    let releaseEnsure!: () => void;
    ensurePause = new Promise<void>((resolve) => {
      releaseEnsure = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      ensureEntered = resolve;
    });
    const removesBefore = removeCalls.length;
    try {
      const firstResume = app.inject({
        method: 'POST',
        url: `/channels/connections/${connection.id}/pairing/${requestId}/approve`,
        headers: { cookie: devCookie(ownerId) },
        payload: {},
      });
      await entered;
      const duplicateResumes = Array.from({ length: 12 }, () =>
        app.inject({
          method: 'POST',
          url: `/channels/connections/${connection.id}/pairing/${requestId}/approve`,
          headers: { cookie: devCookie(ownerId) },
          payload: {},
        }),
      );
      releaseEnsure();
      const [first, ...duplicates] = await Promise.all([firstResume, ...duplicateResumes]);
      expect(first.statusCode).toBe(200);
      expect(duplicates).toHaveLength(12);
      for (const duplicate of duplicates) {
        expect(duplicate.statusCode).toBe(409);
        expect(duplicate.json()).toMatchObject({
          error: { code: 'pairing_request_already_decided' },
        });
      }
    } finally {
      releaseEnsure();
      ensurePause = null;
      ensureEntered = null;
    }
    expect(activeRuntimeAccounts.has(connection.runtimeAccountId)).toBe(true);
    expect(removeCalls).toHaveLength(removesBefore);
  });

  it('serializes approvals behind an existing connection-scoped decision marker', async () => {
    const connection = await activePairingConnection('pairing_serialization');
    const peerId = '77448866';
    const paired = await app.inject({
      method: 'POST',
      url: '/channels/runtime/pairing',
      headers: { authorization: `Bearer ${runtimeToken}` },
      payload: {
        connectionId: connection.id,
        runtimeAccountId: connection.runtimeAccountId,
        ...(await runtimeCoordinates(connection.id)),
        peerId,
        code: 'EDEN-4422',
      },
    });
    expect(paired.statusCode).toBe(200);
    const requestId = (paired.json() as { requestId: string }).requestId;
    const activeMarker = { requestId: randomUUID(), nonce: randomUUID() };
    await pg`
      update channel_connections
      set metadata = metadata || ${pg.json(JSON.stringify({ _pairingDecision: activeMarker }))}
      where id = ${connection.id}
    `;

    const before = await pg<Array<{ connection_metadata: unknown; request_status: string }>>`
      select c.metadata as connection_metadata, p.status as request_status
      from channel_pairing_requests p
      join channel_connections c on c.id = p.connection_id
      where p.id = ${requestId}
    `;
    const callsBefore = ensureCalls.length;
    const denied = await app.inject({
      method: 'POST',
      url: `/channels/connections/${connection.id}/pairing/${requestId}/approve`,
      headers: { cookie: devCookie(ownerId) },
      payload: {},
    });
    expect(denied.statusCode).toBe(409);
    expect(denied.json()).toMatchObject({
      error: { code: 'channel_pairing_decision_in_progress' },
    });
    expect(ensureCalls).toHaveLength(callsBefore);

    const after = await pg<Array<{ connection_metadata: unknown; request_status: string }>>`
      select c.metadata as connection_metadata, p.status as request_status
      from channel_pairing_requests p
      join channel_connections c on c.id = p.connection_id
      where p.id = ${requestId}
    `;
    expect(after).toEqual(before);
    expect(after[0]?.request_status).toBe('pending');
    expect(JSON.stringify(after[0]?.connection_metadata)).not.toContain(peerId);
  });
});

describe('private runtime callbacks', () => {
  async function activeRuntimeFixture(suffix: string) {
    const connection = await createConnection({
      token: `valid_${marker}_runtime_${suffix}`,
      agentUsername: firstAgentUsername,
    });
    const activated = await app.inject({
      method: 'POST',
      url: `/channels/connections/${connection.id}/activate`,
      headers: { cookie: devCookie(ownerId) },
      payload: { dmPolicy: 'pairing', allowFrom: [], discordGuilds: [], telegramGroups: [] },
    });
    expect(activated.statusCode).toBe(200);
    return { connection, runtime: await runtimeCoordinates(connection.id) };
  }

  it('rejects unauthenticated sync and accepts an exact bearer credential', async () => {
    sessionSync.syncMessage.mockClear();
    const { connection, runtime } = await activeRuntimeFixture('messages');
    const body = {
      connectionId: connection.id,
      runtimeAccountId: connection.runtimeAccountId,
      ...runtime,
      gatewaySessionKey: `agent:fixture:discord:${connection.runtimeAccountId}:direct:123456`,
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
      conversationScope: 'direct',
      createdAt: new Date(body.createdAt),
    });
  });

  it('exposes authenticated reserve, settle, and refund transitions', async () => {
    const { connection, runtime } = await activeRuntimeFixture('metering');
    const turnId = randomUUID();
    const headers = { authorization: `Bearer ${runtimeToken}` };
    const reserve = await app.inject({
      method: 'POST',
      url: '/channels/runtime/turns/reserve',
      headers,
      payload: {
        turnId,
        connectionId: connection.id,
        runtimeAccountId: connection.runtimeAccountId,
        ...runtime,
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

describe('Postgres channel group identity isolation', () => {
  it('keeps a pre-linked group participant pseudonymous in membership and authorship', async () => {
    const peerId = '77889911';
    const guildId = '758719600895590441';
    const conversationId = '758719600895590444';
    const connection = await createConnection({
      token: `valid_${marker}_group_identity`,
      agentUsername: firstAgentUsername,
    });
    const activated = await app.inject({
      method: 'POST',
      url: `/channels/connections/${connection.id}/activate`,
      headers: { cookie: devCookie(ownerId) },
      payload: {
        dmPolicy: 'allowlist',
        allowFrom: [peerId],
        discordGuilds: [{ guildId, channelIds: [conversationId] }],
      },
    });
    expect(activated.statusCode).toBe(200);
    const runtime = await runtimeCoordinates(connection.id);

    const service = new ChannelSessionSync(new PostgresChannelSessionSyncStore(), vault);
    await service.syncMessage({
      connectionId: connection.id,
      runtimeAccountId: connection.runtimeAccountId,
      ...runtime,
      gatewaySessionKey: `agent:${marker}:discord:${connection.runtimeAccountId}:direct:${peerId}`,
      conversationId: peerId,
      conversationScope: 'direct',
      peerId,
      externalMessageId: `${marker}:direct-linked-peer`,
      role: 'user',
      content: 'direct identity seed',
      createdAt: new Date(),
    });
    await pg`
      update channel_external_identities
      set linked_account_id = ${strangerId}, updated_at = now()
      where connection_id = ${connection.id}
        and peer_fingerprint = ${channelPeerFingerprint(connection.id, peerId)}
    `;

    const groupSessionKey =
      `agent:${marker}:discord:${connection.runtimeAccountId}:group:${conversationId}`;
    const result = await service.syncMessage({
      connectionId: connection.id,
      runtimeAccountId: connection.runtimeAccountId,
      ...runtime,
      gatewaySessionKey: groupSessionKey,
      conversationId,
      conversationScope: 'group',
      guildId,
      peerId,
      externalMessageId: `${marker}:group-linked-peer`,
      role: 'user',
      content: 'allowlisted group turn',
      createdAt: new Date(),
    });
    expect(result.memoryContext.linkState).toBe('group');

    const messages = await pg<Array<{ sender_id: string | null }>>`
      select m.sender_id
      from messages m
      join sessions s on s.id = m.session_id
      where s.gateway_session_key = ${groupSessionKey}
        and m.external_id = ${marker + ':group-linked-peer'}
    `;
    expect(messages).toEqual([{ sender_id: null }]);
    const members = await pg<{ user_account_id: string }[]>`
      select su.user_account_id
      from session_users su
      join sessions s on s.id = su.session_id
      where s.gateway_session_key = ${groupSessionKey}
    `;
    expect(members.map((member) => member.user_account_id)).toContain(ownerId);
    expect(members.map((member) => member.user_account_id)).not.toContain(strangerId);
  });

  it('rejects a stale authorized snapshot after the connection is deactivated', async () => {
    const peerId = '77889922';
    const connection = await createConnection({
      token: `valid_${marker}_stale_session`,
      agentUsername: firstAgentUsername,
    });
    const activated = await app.inject({
      method: 'POST',
      url: `/channels/connections/${connection.id}/activate`,
      headers: { cookie: devCookie(ownerId) },
      payload: { dmPolicy: 'allowlist', allowFrom: [peerId], discordGuilds: [] },
    });
    expect(activated.statusCode).toBe(200);
    const store = new PostgresChannelSessionSyncStore();
    const snapshot = await store.getLiveConnection(connection.id);
    expect(snapshot).not.toBeNull();
    await pg`
      update channel_connections set desired_state = 'inactive', updated_at = now()
      where id = ${connection.id}
    `;
    const fingerprint = channelPeerFingerprint(connection.id, peerId);
    const encrypted = vault.encrypt(peerId, channelPeerSecretContext(connection.id, fingerprint));
    const gatewaySessionKey =
      `agent:${marker}:discord:${connection.runtimeAccountId}:direct:stale-${peerId}`;
    await expect(
      store.persistMessage({
        connection: snapshot!,
        event: {
          connectionId: connection.id,
          runtimeAccountId: connection.runtimeAccountId,
          agentId: snapshot!.runtimeAgentId,
          ...(snapshot!.bindingId ? { bindingId: snapshot!.bindingId } : {}),
          gatewaySessionKey,
          conversationScope: 'direct',
          externalMessageId: `${marker}:stale-session-message`,
          role: 'user',
          content: 'must not persist',
          createdAt: new Date(),
        },
        authorization: {
          peerId,
          conversationId: peerId,
          conversationScope: 'direct',
        },
        identity: {
          fingerprint,
          ciphertext: encrypted.tokenCiphertext,
          iv: encrypted.tokenIv,
          authTag: encrypted.tokenAuthTag,
          preview: null,
          keyVersion: encrypted.keyVersion,
        },
        conversationFingerprint: channelConversationFingerprint(connection.id, peerId),
        sessionExternalId: randomUUID(),
        safeChannelMetadata: { type: 'discord', readOnly: true },
      }),
    ).rejects.toThrow('channel connection unavailable');
    const sessions = await pg<{ id: string }[]>`
      select id from sessions where gateway_session_key = ${gatewaySessionKey}
    `;
    expect(sessions).toEqual([]);
  });

  it('fails closed for deleted owners, agents, and channel sessions', async () => {
    const peerId = '77889933';
    const connection = await createConnection({
      token: `valid_${marker}_deleted_principal`,
      agentUsername: firstAgentUsername,
    });
    const activated = await app.inject({
      method: 'POST',
      url: `/channels/connections/${connection.id}/activate`,
      headers: { cookie: devCookie(ownerId) },
      payload: { dmPolicy: 'allowlist', allowFrom: [peerId], discordGuilds: [] },
    });
    expect(activated.statusCode).toBe(200);
    const runtime = await runtimeCoordinates(connection.id);
    const gatewaySessionKey =
      `agent:${marker}:discord:${connection.runtimeAccountId}:direct:deleted-${peerId}`;
    const service = new ChannelSessionSync(new PostgresChannelSessionSyncStore(), vault);
    const first = await service.syncMessage({
      connectionId: connection.id,
      runtimeAccountId: connection.runtimeAccountId,
      ...runtime,
      gatewaySessionKey,
      conversationId: peerId,
      conversationScope: 'direct',
      peerId,
      externalMessageId: `${marker}:before-session-delete`,
      role: 'user',
      content: 'session lifecycle seed',
      createdAt: new Date(),
    });
    const meteringStore = new PostgresChannelTurnStore(async () => 'openclaw');
    await pg`
      insert into session_agents (session_id, agent_account_id)
      values (${first.sessionId}, ${secondAgentId})
    `;
    await expect(
      meteringStore.getBillableConnection(connection.id, first.sessionId, runtime),
    ).resolves.toBeNull();
    await expect(
      service.syncMessage({
        connectionId: connection.id,
        runtimeAccountId: connection.runtimeAccountId,
        ...runtime,
        gatewaySessionKey,
        conversationId: peerId,
        conversationScope: 'direct',
        peerId,
        externalMessageId: `${marker}:cross-agent-session`,
        role: 'user',
        content: 'must not cross-bind',
        createdAt: new Date(),
      }),
    ).rejects.toThrow('channel session isolation violation');
    await pg`
      delete from session_agents
      where session_id = ${first.sessionId} and agent_account_id = ${secondAgentId}
    `;
    await pg`update sessions set deleted = true, updated_at = now() where id = ${first.sessionId}`;

    await expect(
      service.syncMessage({
        connectionId: connection.id,
        runtimeAccountId: connection.runtimeAccountId,
        ...runtime,
        gatewaySessionKey,
        conversationId: peerId,
        conversationScope: 'direct',
        peerId,
        externalMessageId: `${marker}:after-session-delete`,
        role: 'user',
        content: 'must not persist',
        createdAt: new Date(),
      }),
    ).rejects.toThrow('channel session isolation violation');
    await expect(
      meteringStore.getBillableConnection(connection.id, first.sessionId, runtime),
    ).resolves.toBeNull();

    const runtimeBody = {
      connectionId: connection.id,
      runtimeAccountId: connection.runtimeAccountId,
      ...runtime,
      gatewaySessionKey,
      peerId,
      externalMessageId: `${marker}:deleted-principal`,
      role: 'user',
      content: 'must not reach session sync',
      createdAt: new Date().toISOString(),
    };
    const callsBefore = sessionSync.syncMessage.mock.calls.length;
    try {
      await pg`update accounts set deleted = true, updated_at = now() where id = ${ownerId}`;
      const deletedOwner = await app.inject({
        method: 'POST',
        url: '/channels/runtime/messages',
        headers: { authorization: `Bearer ${runtimeToken}` },
        payload: runtimeBody,
      });
      expect(deletedOwner.statusCode).toBe(404);
    } finally {
      await pg`update accounts set deleted = false, updated_at = now() where id = ${ownerId}`;
    }
    try {
      await pg`update accounts set deleted = true, updated_at = now() where id = ${firstAgentId}`;
      const deletedAgent = await app.inject({
        method: 'POST',
        url: '/channels/runtime/messages',
        headers: { authorization: `Bearer ${runtimeToken}` },
        payload: runtimeBody,
      });
      expect(deletedAgent.statusCode).toBe(404);
    } finally {
      await pg`update accounts set deleted = false, updated_at = now() where id = ${firstAgentId}`;
    }
    expect(sessionSync.syncMessage).toHaveBeenCalledTimes(callsBefore);
  });
});

describe('channel money crash boundaries against Postgres', () => {
  it('does not debit or return a provider ticket when deactivation wins after claim', async () => {
    const connection = await createConnection({
      token: `valid_${marker}_money_revoke_race`,
      agentUsername: firstAgentUsername,
    });
    const activated = await app.inject({
      method: 'POST',
      url: `/channels/connections/${connection.id}/activate`,
      headers: { cookie: devCookie(ownerId) },
      payload: { dmPolicy: 'pairing', allowFrom: [], discordGuilds: [] },
    });
    expect(activated.statusCode).toBe(200);
    const runtime = await runtimeCoordinates(connection.id);
    await credit({
      accountId: ownerId,
      amount: 1_000,
      type: 'credit:test:channel-revoke-race',
      idempotencyKey: `channel-revoke-race-credit:${marker}`,
    });
    let releaseAuthorize!: () => void;
    const pauseAuthorize = new Promise<void>((resolve) => {
      releaseAuthorize = resolve;
    });
    let authorizeEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      authorizeEntered = resolve;
    });
    class PausedAuthorizationStore extends PostgresChannelTurnStore {
      override async authorize(...args: Parameters<PostgresChannelTurnStore['authorize']>) {
        authorizeEntered();
        await pauseAuthorize;
        return super.authorize(...args);
      }
    }
    const service = new ChannelTurnMeteringService(
      new PausedAuthorizationStore(async () => 'openclaw'),
    );
    const turnId = randomUUID();
    const balanceBefore = (await getBalance(ownerId)).total;
    const reservation = service.reserve({
      turnId,
      connectionId: connection.id,
      runtimeAccountId: connection.runtimeAccountId,
      ...runtime,
    });
    expect(await resolvesWithin(entered)).toBe(true);
    await pg`
      update channel_connections set desired_state = 'inactive', updated_at = now()
      where id = ${connection.id}
    `;
    releaseAuthorize();
    await expect(reservation).rejects.toThrow('channel connection unavailable');
    expect((await getBalance(ownerId)).total).toBe(balanceBefore);
    const rows = await pg<
      Array<{ status: string; authorization_count: number; debit_count: number }>
    >`
      select ct.status,
             (select count(*)::int from turn_authorizations ta where ta.turn_id = ct.turn_id)
               as authorization_count,
             (
               select count(*)::int from manna_transactions mt
               where mt.idempotency_key = ${channelTurnLedgerKey(turnId)}
             ) as debit_count
      from channel_turns ct where ct.turn_id = ${turnId}
    `;
    expect(rows).toEqual([{ status: 'error', authorization_count: 0, debit_count: 0 }]);
  });

  it('keeps settled authorization terminal while compensation and delivered rescue serialize exactly', async () => {
    const connection = await createConnection({
      token: `valid_${marker}_money_crash_boundary`,
      agentUsername: firstAgentUsername,
    });
    const activated = await app.inject({
      method: 'POST',
      url: `/channels/connections/${connection.id}/activate`,
      headers: { cookie: devCookie(ownerId) },
      payload: { dmPolicy: 'pairing', allowFrom: [], discordGuilds: [], telegramGroups: [] },
    });
    expect(activated.statusCode).toBe(200);
    await credit({
      accountId: ownerId,
      amount: 1_000,
      type: 'credit:test:channel-crash',
      idempotencyKey: `channel-crash-credit:${marker}`,
    });
    const store = new PostgresChannelTurnStore(async () => 'openclaw');
    const metering = new ChannelTurnMeteringService(store);
    const execution = {
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      agentRuntime: 'openclaw' as const,
    };
    const settle = async (turnId: string) => {
      await metering.reserve({
        turnId,
        connectionId: connection.id,
        runtimeAccountId: connection.runtimeAccountId,
      });
      return metering.settle(
        turnId,
        { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
        execution,
      );
    };

    const compensatedTurn = randomUUID();
    const balanceBeforeCompensation = (await getBalance(ownerId)).total;
    const charged = await settle(compensatedTurn);
    expect((await getBalance(ownerId)).total).toBe(balanceBeforeCompensation - charged.chargedManna);
    await metering.refundDeliveryFailure(compensatedTurn);
    await metering.refundDeliveryFailure(compensatedTurn);
    expect((await getBalance(ownerId)).total).toBe(balanceBeforeCompensation);
    const compensated = await pg<Array<{
      channel_status: string;
      error_code: string | null;
      authorization_state: string;
      charged_manna: string;
      usage_status: string;
      usage_manna: string;
      reversal_count: number;
    }>>`
      select ct.status as channel_status, ct.error_code,
             ta.state as authorization_state, ta.charged_manna,
             ue.status as usage_status, ue.manna as usage_manna,
             (
               select count(*)::int from manna_transactions mt
               where mt.idempotency_key = ${`refund:${channelTurnLedgerKey(compensatedTurn)}`}
             ) as reversal_count
      from channel_turns ct
      join turn_authorizations ta on ta.turn_id = ct.turn_id
      join usage_events ue on ue.turn_id = ct.turn_id and ue.event_type = 'channel_chat'
      where ct.turn_id = ${compensatedTurn}
    `;
    expect(compensated[0]).toMatchObject({
      channel_status: 'refunded',
      error_code: 'channel_delivery_failed',
      authorization_state: 'settled',
      usage_status: 'error',
      reversal_count: 1,
    });
    expect(Number(compensated[0]!.usage_manna)).toBe(0);

    const rescuedTurn = randomUUID();
    await settle(rescuedTurn);
    const claimed = await store.claimRefund(rescuedTurn, false, true);
    expect(claimed).toMatchObject({ claimed: true, errorCode: 'channel_delivery_compensation_pending' });
    await store.markRefundFailed(rescuedTurn, 'channel_delivery_failed_refund_failed');
    await store.markDelivered(rescuedTurn);
    const rescued = await pg<{ status: string; reversal_count: number }[]>`
      select ct.status,
             (
               select count(*)::int from manna_transactions mt
               where mt.idempotency_key = ${`refund:${channelTurnLedgerKey(rescuedTurn)}`}
             ) as reversal_count
      from channel_turns ct where ct.turn_id = ${rescuedTurn}
    `;
    expect(rescued[0]).toEqual({ status: 'delivered', reversal_count: 0 });

    const compensationWonTurn = randomUUID();
    await settle(compensationWonTurn);
    await metering.refundDeliveryFailure(compensationWonTurn);
    await expect(store.markDelivered(compensationWonTurn)).rejects.toBeInstanceOf(
      ChannelDeliveryTerminalCompensatedError,
    );

    const staleDeliveryTurn = randomUUID();
    await settle(staleDeliveryTurn);
    await pg`
      update channel_turns
      set updated_at = now() - interval '2 hours'
      where turn_id = ${staleDeliveryTurn}
    `;
    expect(await metering.refundStale({ olderThanMs: 60_000, limit: 100 })).toBeGreaterThan(0);
    const staleDelivery = await pg<
      Array<{
        channel_status: string;
        error_code: string | null;
        authorization_state: string;
        usage_status: string;
        usage_error_code: string | null;
        reversal_count: number;
      }>
    >`
      select ct.status as channel_status, ct.error_code,
             ta.state as authorization_state, ue.status as usage_status,
             ue.error_code as usage_error_code,
             (
               select count(*)::int from manna_transactions mt
               where mt.idempotency_key = ${`refund:${channelTurnLedgerKey(staleDeliveryTurn)}`}
             ) as reversal_count
      from channel_turns ct
      join turn_authorizations ta on ta.turn_id = ct.turn_id
      join usage_events ue on ue.turn_id = ct.turn_id and ue.event_type = 'channel_chat'
      where ct.turn_id = ${staleDeliveryTurn}
    `;
    expect(staleDelivery[0]).toEqual({
      channel_status: 'refunded',
      error_code: 'channel_delivery_failed',
      authorization_state: 'settled',
      usage_status: 'error',
      usage_error_code: 'channel_delivery_failed',
      reversal_count: 1,
    });
  });
});
