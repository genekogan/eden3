import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { TurnCeilingError } from '@eden3/core';

import {
  ChannelDeliveryTerminalDeliveredError,
  ChannelExecutionMismatchError,
  REAPABLE_CHANNEL_TURN_STATUSES,
  ChannelTurnMeteringService,
  assertChannelReservationReplay,
  assertChannelExecutionMatches,
  channelAuthorizationReversalKind,
  isBillableChannelTurnProvenance,
  meterChannelUsage,
  type BillableChannelConnection,
  type ChannelTurnRecord,
  type ChannelTurnStoreLike,
} from '../src/services/channel-metering.js';

const connection: BillableChannelConnection = {
  connectionId: randomUUID(),
  runtimeAccountId: 'eden-one',
  accountId: randomUUID(),
  agentId: randomUUID(),
  channel: 'telegram',
  model: 'anthropic/claude-haiku-4-5',
  agentRuntime: 'openclaw',
  pricingBasis: 'provider-api',
};

const execution = {
  provider: 'anthropic',
  model: 'claude-haiku-4-5',
  agentRuntime: 'openclaw' as const,
};

function turn(status: ChannelTurnRecord['status'], overrides: Partial<ChannelTurnRecord> = {}): ChannelTurnRecord {
  return {
    ...connection,
    turnId: randomUUID(),
    sessionId: randomUUID(),
    externalMessageId: 'telegram:42',
    status,
    reservedManna: 61,
    meteredManna: null,
    provenanceStatus: 'frozen',
    ...overrides,
  };
}

function store(overrides: Partial<ChannelTurnStoreLike> = {}): ChannelTurnStoreLike {
  return {
    getBillableConnection: vi.fn(async () => connection),
    claimTurn: vi.fn(),
    getTurn: vi.fn(),
    claimSettlement: vi.fn(),
    claimRefund: vi.fn(),
    claimStale: vi.fn(async () => []),
    markDelivered: vi.fn(),
    markUsableOutput: vi.fn(),
    markError: vi.fn(),
    authorize: vi.fn(async () => ({ balance: 39, replayed: false })),
    settleAuthorized: vi.fn(),
    reverseAuthorized: vi.fn(),
    markRefundFailed: vi.fn(),
    ...overrides,
  };
}

describe('ChannelTurnMeteringService economic authorization', () => {
  it('FG-ECON-CHANNEL-01 reserves the frozen worst-case ceiling before returning provider permission', async () => {
    const record = turn('reserving');
    const runtimeBinding = {
      agentId: 'runtime-agent-one',
      bindingId: '33333333-3333-4333-8333-333333333333',
    };
    const events: string[] = [];
    const persistence = store({
      claimTurn: vi.fn(async (_connection, _input, amount) => {
        events.push(`claim:${amount}`);
        return record;
      }),
      authorize: vi.fn(async (candidate) => {
        events.push(`authorize:${candidate.reservedManna}`);
        return { balance: 39, replayed: false };
      }),
    });

    const result = await new ChannelTurnMeteringService(persistence).reserve({
      turnId: record.turnId,
      connectionId: connection.connectionId,
      runtimeAccountId: connection.runtimeAccountId,
      ...runtimeBinding,
      sessionId: record.sessionId,
      externalMessageId: record.externalMessageId,
    });

    expect(events).toEqual(['claim:61', 'authorize:61']);
    expect(persistence.getBillableConnection).toHaveBeenCalledWith(
      connection.connectionId,
      record.sessionId,
      runtimeBinding,
    );
    expect(persistence.authorize).toHaveBeenCalledWith(record, runtimeBinding);
    expect(result).toMatchObject({ balance: 39, replayed: false, turn: { status: 'reserved' } });
  });

  it('fails before provider permission when the worst-case reservation is unaffordable', async () => {
    const record = turn('reserving');
    const persistence = store({
      claimTurn: vi.fn(async () => record),
      authorize: vi.fn(async () => {
        throw new Error('insufficient manna');
      }),
    });
    await expect(
      new ChannelTurnMeteringService(persistence).reserve({
        turnId: record.turnId,
        connectionId: connection.connectionId,
        runtimeAccountId: connection.runtimeAccountId,
        sessionId: record.sessionId,
        externalMessageId: record.externalMessageId,
      }),
    ).rejects.toThrow('insufficient manna');
    expect(persistence.markError).toHaveBeenCalledWith(record.turnId, 'reserve_failed');
  });

  it('fails closed before any provider permission when the model has no authorization ceiling', async () => {
    const unsupported = {
      ...connection,
      model: 'openrouter/anthropic/claude-haiku-4-5',
      pricingBasis: 'provider-reported' as const,
    };
    const persistence = store({
      getBillableConnection: vi.fn(async () => unsupported),
    });
    await expect(
      new ChannelTurnMeteringService(persistence).reserve({
        turnId: randomUUID(),
        connectionId: unsupported.connectionId,
        runtimeAccountId: unsupported.runtimeAccountId,
      }),
    ).rejects.toBeInstanceOf(TurnCeilingError);

    // `reserve` is the runtime's provider-permission gate. An unsupported
    // ceiling never creates/claims a turn and can never authorize execution.
    expect(persistence.claimTurn).not.toHaveBeenCalled();
    expect(persistence.authorize).not.toHaveBeenCalled();
  });

  it('rejects a pre-kernel flat debit or missing authorization on reservation replay', () => {
    const valid = {
      recordedAmount: '-61.0000',
      recordedType: 'spend:chat:channel',
      reservedManna: 61,
      payerMatches: true,
      wasRefunded: false,
      hasLiveAuthorization: true,
    };
    expect(() => assertChannelReservationReplay(valid)).not.toThrow();
    expect(() =>
      assertChannelReservationReplay({ ...valid, recordedAmount: '-1.0000' }),
    ).toThrow('replay conflict');
    expect(() =>
      assertChannelReservationReplay({ ...valid, hasLiveAuthorization: false }),
    ).toThrow('replay conflict');
    expect(() =>
      assertChannelReservationReplay({ ...valid, wasRefunded: true }),
    ).toThrow('replay conflict');
  });

  it('never turns an existing authorization into a reusable provider ticket', async () => {
    for (const status of ['reserved', 'settled', 'delivery_pending', 'delivered'] as const) {
      const record = turn(status);
      const persistence = store({ claimTurn: vi.fn(async () => record) });
      await expect(
        new ChannelTurnMeteringService(persistence).reserve({
          turnId: record.turnId,
          connectionId: record.connectionId,
          runtimeAccountId: record.runtimeAccountId,
          sessionId: record.sessionId,
          externalMessageId: record.externalMessageId,
        }),
      ).rejects.toThrow('replay denied');
      expect(persistence.authorize).not.toHaveBeenCalled();
    }
  });

  it('FG-ECON-CHANNEL-02 never charges above authorized-max and records the clamped settlement', async () => {
    const record = turn('settling');
    const persistence = store({
      getTurn: vi.fn(async () => turn('reserved', record)),
      claimSettlement: vi.fn(async () => ({ turn: record, claimed: true })),
    });
    const result = await new ChannelTurnMeteringService(persistence).settle(
      record.turnId,
      { promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 },
      execution,
    );
    expect(result.metering.status).toBe('metered');
    expect(result.metering.manna).toBeGreaterThan(record.reservedManna);
    expect(result.chargedManna).toBe(record.reservedManna);
    expect(persistence.settleAuthorized).toHaveBeenCalledWith(
      record,
      expect.anything(),
      expect.objectContaining({ status: 'metered' }),
      record.reservedManna,
    );
  });

  it('charges the full authorized reserve when trusted usage is missing', async () => {
    const record = turn('settling');
    const persistence = store({
      getTurn: vi.fn(async () => turn('reserved', record)),
      claimSettlement: vi.fn(async () => ({ turn: record, claimed: true })),
    });
    await expect(
      new ChannelTurnMeteringService(persistence).settle(record.turnId, undefined, execution),
    ).resolves.toMatchObject({ chargedManna: record.reservedManna, metering: { status: 'missing_usage' } });
  });

  it('FG-ECON-CHANNEL-03 uses authoritative OpenRouter usage.cost instead of token-table estimation', () => {
    const metering = meterChannelUsage(
      { promptTokens: 999_999, completionTokens: 999_999, providerCostUsd: 0.0123 },
      'openrouter/anthropic/claude-haiku-4-5',
    );
    expect(metering).toMatchObject({
      status: 'metered',
      provider: 'openrouter',
      costUsd: 0.0123,
      estimated: false,
      tableVersion: 'openrouter-usage.cost-v1',
    });
    expect(meterChannelUsage({}, 'openrouter/model')).toMatchObject({ status: 'missing_usage' });
  });

  it('FG-ECON-CHANNEL-04 reverses split-exact authorization after a terminal-write failure', async () => {
    const record = turn('settling');
    const persistence = store({
      getTurn: vi.fn(async () => turn('reserved', record)),
      claimSettlement: vi.fn(async () => ({ turn: record, claimed: true })),
      settleAuthorized: vi.fn(async () => {
        throw new Error('database unavailable');
      }),
      claimRefund: vi.fn(async () => ({
        turnId: record.turnId,
        status: 'refunding' as const,
        claimed: true,
      })),
    });
    await expect(
      new ChannelTurnMeteringService(persistence).settle(
        record.turnId,
        { promptTokens: 10 },
        execution,
      ),
    ).rejects.toThrow('database unavailable');
    expect(persistence.reverseAuthorized).toHaveBeenCalledWith(record.turnId, 'settlement_failed');
  });

  it('reaps every crash-open state through the durable authorization reversal', async () => {
    expect(REAPABLE_CHANNEL_TURN_STATUSES).toEqual(
      expect.arrayContaining(['reserving', 'reserved', 'settling', 'delivery_pending', 'refunding', 'error']),
    );
    const ids = [randomUUID(), randomUUID()];
    const persistence = store({ claimStale: vi.fn(async () => ids) });
    await expect(
      new ChannelTurnMeteringService(persistence).refundStale({ olderThanMs: 60_000 }),
    ).resolves.toBe(2);
    expect(persistence.reverseAuthorized).toHaveBeenCalledTimes(2);
  });

  it('compensates a provider-complete turn when native delivery fails', async () => {
    const record = turn('delivery_pending');
    const persistence = store({
      claimRefund: vi.fn(async () => ({
        turnId: record.turnId,
        status: 'refunding' as const,
        claimed: true,
      })),
    });
    await new ChannelTurnMeteringService(persistence).refundDeliveryFailure(record.turnId);
    expect(persistence.claimRefund).toHaveBeenCalledWith(record.turnId, false, true);
    expect(persistence.reverseAuthorized).toHaveBeenCalledWith(record.turnId, 'channel_delivery_failed');
  });

  it('accepts only an exact compensation replay and rejects a different prior reversal', async () => {
    const turnId = randomUUID();
    const exactReplay = store({
      claimRefund: vi.fn(async () => ({
        turnId,
        status: 'refunded' as const,
        claimed: false,
        errorCode: 'channel_delivery_failed',
      })),
    });
    await expect(new ChannelTurnMeteringService(exactReplay).refundDeliveryFailure(turnId)).resolves.toBeUndefined();
    expect(exactReplay.reverseAuthorized).not.toHaveBeenCalled();

    const different = store({
      claimRefund: vi.fn(async () => ({
        turnId,
        status: 'refunded' as const,
        claimed: false,
        errorCode: 'runtime_refund',
      })),
    });
    await expect(new ChannelTurnMeteringService(different).refundDeliveryFailure(turnId)).rejects.toThrow(
      'not refundable',
    );
    expect(different.reverseAuthorized).not.toHaveBeenCalled();
  });

  it('refuses the opposite delivery-failed terminal after native delivery already won', async () => {
    const turnId = randomUUID();
    const delivered = store({
      claimRefund: vi.fn(async () => ({ turnId, status: 'delivered' as const, claimed: false })),
    });
    await expect(new ChannelTurnMeteringService(delivered).refundDeliveryFailure(turnId))
      .rejects.toBeInstanceOf(ChannelDeliveryTerminalDeliveredError);
    expect(delivered.reverseAuthorized).not.toHaveBeenCalled();
  });

  it('keeps settled authorization terminal and permits only the delivery-pending compensation marker', () => {
    expect(
      channelAuthorizationReversalKind({
        authorizationState: 'reserved',
        channelStatus: 'refunding',
        channelErrorCode: 'runtime_refund',
      }),
    ).toBe('pre_settlement');
    expect(
      channelAuthorizationReversalKind({
        authorizationState: 'settled',
        channelStatus: 'refunding',
        channelErrorCode: 'channel_delivery_compensation_pending',
      }),
    ).toBe('delivery_compensation');
    for (const invalid of [
      { authorizationState: 'settled', channelStatus: 'delivery_pending', channelErrorCode: null },
      { authorizationState: 'settled', channelStatus: 'refunding', channelErrorCode: 'runtime_refund' },
      { authorizationState: 'settled', channelStatus: 'delivered', channelErrorCode: 'channel_delivery_compensation_pending' },
    ]) {
      expect(() => channelAuthorizationReversalKind(invalid)).toThrow('not reversible');
    }
  });

  it('pins every channel crash boundary to reversal, compensation, or delivered finality', () => {
    const crashPoints = [
      { point: 'before provider completion', authorization: 'reserved', channel: 'reserved', reapable: true },
      { point: 'after provider completion before settlement', authorization: 'reserved', channel: 'settling', reapable: true },
      { point: 'after settlement before transcript write', authorization: 'settled', channel: 'delivery_pending', reapable: true },
      { point: 'after transcript write before native delivery', authorization: 'settled', channel: 'delivery_pending', reapable: true },
      { point: 'after native delivery', authorization: 'settled', channel: 'delivered', reapable: false },
      { point: 'during compensation', authorization: 'settled', channel: 'refunding', reapable: true },
    ] as const;
    for (const crash of crashPoints) {
      expect(REAPABLE_CHANNEL_TURN_STATUSES.includes(crash.channel)).toBe(crash.reapable);
      if (crash.point === 'during compensation') {
        expect(
          channelAuthorizationReversalKind({
            authorizationState: crash.authorization,
            channelStatus: crash.channel,
            channelErrorCode: 'channel_delivery_compensation_pending',
          }),
        ).toBe('delivery_compensation');
      }
      if (crash.point === 'after native delivery') {
        expect(() =>
          channelAuthorizationReversalKind({
            authorizationState: crash.authorization,
            channelStatus: crash.channel,
            channelErrorCode: null,
          }),
        ).toThrow('not reversible');
      }
    }
  });

  it('keeps failed delivery compensation retryable through the refunding reaper state', () => {
    expect(REAPABLE_CHANNEL_TURN_STATUSES).toContain('refunding');
    expect(
      channelAuthorizationReversalKind({
        authorizationState: 'settled',
        channelStatus: 'refunding',
        channelErrorCode: 'channel_delivery_compensation_pending',
      }),
    ).toBe('delivery_compensation');
  });

  it('rejects cross-bot replay attribution before authorization', async () => {
    const record = turn('reserved');
    const persistence = store({ claimTurn: vi.fn(async () => record) });
    await expect(
      new ChannelTurnMeteringService(persistence).reserve({
        turnId: record.turnId,
        connectionId: connection.connectionId,
        runtimeAccountId: 'another-bot',
      }),
    ).rejects.toThrow('channel connection unavailable');
    expect(persistence.authorize).not.toHaveBeenCalled();
  });

  it('binds settlement to the frozen provider/model/runtime tuple', () => {
    expect(() => assertChannelExecutionMatches(connection, execution)).not.toThrow();
    expect(() =>
      assertChannelExecutionMatches(connection, { ...execution, model: 'claude-opus-4-6' }),
    ).toThrow(ChannelExecutionMismatchError);
    expect(isBillableChannelTurnProvenance('frozen')).toBe(true);
    expect(isBillableChannelTurnProvenance('legacy_refund_pending')).toBe(false);
  });
});
