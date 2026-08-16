import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pg } from '@eden3/db';

import { buildServer } from '../src/server.js';
import { ChannelDeliveryTerminalDeliveredError } from '../src/services/channel-metering.js';
import {
  deleteFixturesByMarker,
  insertAgentAccount,
  insertUserAccount,
  makeMarker,
} from './fixtures';

let app: FastifyInstance;
const marker = makeMarker('channel_runtime_contract');
const runtimeToken = 'runtime-route-contract-token';
const runtimeAccountId = 'eden-runtime-account';
const connectionId = randomUUID();
const syncMessage = vi.fn(async () => ({
  sessionId: randomUUID(),
  messageId: randomUUID(),
  inserted: true,
  memoryContext: {
    linkState: 'pseudonymous' as const,
    relativePath: 'memory/users/channel-peer-fixture.md',
  },
}));
const reserve = vi.fn(async (input: {
  turnId: string;
  connectionId: string;
  runtimeAccountId: string;
}) => ({
  turn: {
    turnId: input.turnId,
    connectionId: input.connectionId,
    runtimeAccountId: input.runtimeAccountId,
    accountId: randomUUID(),
    agentId: randomUUID(),
    channel: 'discord' as const,
    model: 'anthropic/claude-haiku-4-5',
    agentRuntime: 'openclaw' as const,
    pricingBasis: 'provider-api' as const,
    sessionId: null,
    externalMessageId: null,
    status: 'reserved' as const,
    reservedManna: 1,
    meteredManna: null,
    provenanceStatus: 'frozen' as const,
  },
  balance: 50,
  replayed: false,
}));
const settle = vi.fn(async () => ({
  chargedManna: 1,
  metering: {
    status: 'missing_usage' as const,
    provider: 'anthropic' as const,
    model: 'claude-haiku-4-5',
    modelSource: 'agent' as const,
    costUsd: null,
    manna: null,
  },
}));
const refundDeliveryFailure = vi.fn(async () => {});
const markDelivered = vi.fn(async () => {});
const refundChannelVoiceDelivery = vi.fn(async () => true);
const settleChannelVoiceDelivery = vi.fn(async () => true);

beforeAll(async () => {
  const ownerId = await insertUserAccount(`${marker}_owner`);
  const agentId = await insertAgentAccount(`${marker}_agent`, {
    ownerId,
    openclawId: `${marker}_agent`,
    workspacePath: `/tmp/${marker}_agent`,
    provisionStatus: 'ready',
    provisionedAt: new Date(),
  });
  await pg`
    insert into channel_connections (
      id,account_id,agent_id,channel,runtime_account_id,desired_state,observed_state,status,
      token_ciphertext,token_iv,token_auth_tag,token_sha256,key_version,metadata
    ) values (
      ${connectionId},${ownerId},${agentId},'discord',${runtimeAccountId},'active','live','connected',
      'fixture-cipher','fixture-iv','fixture-tag',${'0'.repeat(64)},'v1','{}'::jsonb
    )
  `;
  app = await buildServer({
    gateway: null,
    channels: {
      runtimeToken,
      vault: {
        encrypt: vi.fn(() => ({
          tokenCiphertext: 'cipher',
          tokenIv: 'iv',
          tokenAuthTag: 'tag',
          tokenSha256: 'hash',
          tokenPreview: '1234',
          keyVersion: 'v1',
        })),
        decrypt: vi.fn(() => 'secret'),
      },
      sessionSync: { syncMessage },
      xConnector: {
        connect: vi.fn(),
        post: vi.fn(),
        revoke: vi.fn(),
      },
      turnMetering: {
        reserve,
        settle,
        refund: vi.fn(async () => {}),
        refundDeliveryFailure,
        markDelivered,
      },
      voiceDelivery: { refundChannelVoiceDelivery, settleChannelVoiceDelivery },
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await deleteFixturesByMarker(marker);
});

describe('private channel runtime routes', () => {
  it('authenticates and normalizes a sync-back event without touching Postgres', async () => {
    const payload = {
      connectionId,
      runtimeAccountId,
      gatewaySessionKey: 'agent:fixture:discord:eden-runtime-account:direct:12345',
      conversationId: 'discord-dm-12345',
      peerId: '12345',
      externalMessageId: 'discord:message:7',
      role: 'user',
      content: 'hello',
      createdAt: '2026-07-31T12:00:00.000Z',
      sourceSequence: 7,
    };
    const denied = await app.inject({
      method: 'POST',
      url: '/channels/runtime/messages',
      payload,
    });
    expect(denied.statusCode).toBe(401);
    expect(syncMessage).not.toHaveBeenCalled();

    const accepted = await app.inject({
      method: 'POST',
      url: '/channels/runtime/messages',
      headers: { authorization: `Bearer ${runtimeToken}` },
      payload,
    });
    expect(accepted.statusCode).toBe(200);
    expect(syncMessage).toHaveBeenCalledWith({
      ...payload,
      conversationScope: 'direct',
      createdAt: new Date(payload.createdAt),
    });
    expect(accepted.json()).toMatchObject({
      ok: true,
      memoryContext: {
        linkState: 'pseudonymous',
        relativePath: 'memory/users/channel-peer-fixture.md',
      },
    });
  });

  it('exposes the reserve contract only behind runtime auth', async () => {
    const payload = {
      turnId: randomUUID(),
      connectionId,
      runtimeAccountId,
    };
    const accepted = await app.inject({
      method: 'POST',
      url: '/channels/runtime/turns/reserve',
      headers: { authorization: `Bearer ${runtimeToken}` },
      payload,
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      ok: true,
      turnId: payload.turnId,
      reservedManna: 1,
      balance: 50,
      model: 'anthropic/claude-haiku-4-5',
      agentRuntime: 'openclaw',
      pricingBasis: 'provider-api',
    });
    expect(reserve).toHaveBeenCalledWith(payload);
  });

  it('requires and forwards trusted execution provenance at settlement', async () => {
    const turnId = randomUUID();
    const missing = await app.inject({
      method: 'POST',
      url: `/channels/runtime/turns/${turnId}/settle`,
      headers: { authorization: `Bearer ${runtimeToken}` },
      payload: { usage: { promptTokens: 1 } },
    });
    expect(missing.statusCode).toBe(400);
    expect(settle).not.toHaveBeenCalled();

    const accepted = await app.inject({
      method: 'POST',
      url: `/channels/runtime/turns/${turnId}/settle`,
      headers: { authorization: `Bearer ${runtimeToken}` },
      payload: {
        usage: { promptTokens: 10, completionTokens: 2 },
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        agentRuntime: 'openclaw',
      },
    });
    expect(accepted.statusCode).toBe(200);
    expect(settle).toHaveBeenCalledWith(
      turnId,
      { promptTokens: 10, completionTokens: 2 },
      {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        agentRuntime: 'openclaw',
      },
    );
  });

  it('compensates a failed outbound delivery only behind runtime auth', async () => {
    const turnId = randomUUID();
    const denied = await app.inject({
      method: 'POST',
      url: `/channels/runtime/turns/${turnId}/delivery-failed`,
    });
    expect(denied.statusCode).toBe(401);
    expect(refundDeliveryFailure).not.toHaveBeenCalled();

    const accepted = await app.inject({
      method: 'POST',
      url: `/channels/runtime/turns/${turnId}/delivery-failed`,
      headers: { authorization: `Bearer ${runtimeToken}` },
    });
    expect(accepted.statusCode).toBe(200);
    expect(refundDeliveryFailure).toHaveBeenCalledWith(turnId);
    expect(refundChannelVoiceDelivery).toHaveBeenCalledWith(turnId, 'channel_delivery_failed');
  });

  it('maps an opposite delivery-failed callback after delivered to an exact safe conflict', async () => {
    const turnId = randomUUID();
    const voiceCalls = refundChannelVoiceDelivery.mock.calls.length;
    refundDeliveryFailure.mockRejectedValueOnce(new ChannelDeliveryTerminalDeliveredError());
    const response = await app.inject({
      method: 'POST',
      url: `/channels/runtime/turns/${turnId}/delivery-failed`,
      headers: { authorization: `Bearer ${runtimeToken}` },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: 'channel_turn_terminal_delivered',
        message: 'Channel turn was already terminal-delivered',
        statusCode: 409,
      },
    });
    expect(refundChannelVoiceDelivery).toHaveBeenCalledTimes(voiceCalls);
  });

  it('finalizes successful outbound delivery only behind runtime auth', async () => {
    const turnId = randomUUID();
    const denied = await app.inject({
      method: 'POST',
      url: `/channels/runtime/turns/${turnId}/delivered`,
    });
    expect(denied.statusCode).toBe(401);
    expect(markDelivered).not.toHaveBeenCalled();

    const accepted = await app.inject({
      method: 'POST',
      url: `/channels/runtime/turns/${turnId}/delivered`,
      headers: { authorization: `Bearer ${runtimeToken}` },
    });
    expect(accepted.statusCode).toBe(200);
    expect(markDelivered).toHaveBeenCalledWith(turnId);
    expect(settleChannelVoiceDelivery).toHaveBeenCalledWith(turnId);
  });
});
