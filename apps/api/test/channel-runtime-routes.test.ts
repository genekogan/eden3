import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildServer } from '../src/server.js';

let app: FastifyInstance;
const runtimeToken = 'runtime-route-contract-token';
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

beforeAll(async () => {
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
    },
  });
  await app.ready();
});

afterAll(async () => app.close());

describe('private channel runtime routes', () => {
  it('authenticates and normalizes a sync-back event without touching Postgres', async () => {
    const payload = {
      connectionId: randomUUID(),
      runtimeAccountId: 'eden-runtime-account',
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
      connectionId: randomUUID(),
      runtimeAccountId: 'eden-runtime-account',
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
  });
});
