import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  ChannelExecutionMismatchError,
  REAPABLE_CHANNEL_TURN_STATUSES,
  ChannelTurnMeteringService,
  assertChannelExecutionMatches,
  channelTurnLedgerKey,
  channelTurnSettlementLedgerKey,
  isBillableChannelTurnProvenance,
  type BillableChannelConnection,
  type ChannelLedgerLike,
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

function turn(status: ChannelTurnRecord['status']): ChannelTurnRecord {
  return {
    ...connection,
    turnId: randomUUID(),
    sessionId: randomUUID(),
    externalMessageId: 'telegram:42',
    status,
    reservedManna: 1,
    meteredManna: null,
    provenanceStatus: 'frozen',
  };
}

function ledgerResult(balance = 9) {
  return {
    transaction: {} as never,
    balance: { balance, subscriptionBalance: 0, total: balance },
    alreadyApplied: false,
  };
}

function ledger(): ChannelLedgerLike {
  return {
    debit: vi.fn(async () => ledgerResult()),
    refund: vi.fn(async () => ledgerResult()),
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
    markReserved: vi.fn(),
    markError: vi.fn(),
    settle: vi.fn(),
    markRefunded: vi.fn(),
    markRefundFailed: vi.fn(),
    ...overrides,
  };
}

describe('ChannelTurnMeteringService', () => {
  it('treats only frozen or usage-recovered provenance as billable', () => {
    expect(isBillableChannelTurnProvenance('frozen')).toBe(true);
    expect(isBillableChannelTurnProvenance('recovered_usage_event')).toBe(true);
    expect(isBillableChannelTurnProvenance('unknown')).toBe(false);
    expect(isBillableChannelTurnProvenance('legacy_terminal_unknown')).toBe(false);
    expect(isBillableChannelTurnProvenance('legacy_refund_pending')).toBe(false);
  });

  it('accepts runtime-specific provider provenance and rejects forged provider/model pairs', () => {
    expect(() => assertChannelExecutionMatches(connection, execution)).not.toThrow();
    const cliTurn = {
      model: 'anthropic/claude-sonnet-4-6',
      agentRuntime: 'claude-cli' as const,
    };
    expect(() =>
      assertChannelExecutionMatches(cliTurn, {
        provider: 'claude-cli',
        model: 'claude-cli/claude-sonnet-4-6',
        agentRuntime: 'claude-cli',
      }),
    ).not.toThrow();
    expect(() =>
      assertChannelExecutionMatches(cliTurn, {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        agentRuntime: 'claude-cli',
      }),
    ).toThrow(ChannelExecutionMismatchError);
    expect(() =>
      assertChannelExecutionMatches(cliTurn, {
        provider: 'claude-cli',
        model: 'claude-cli/claude-opus-4-1',
        agentRuntime: 'claude-cli',
      }),
    ).toThrow(ChannelExecutionMismatchError);
  });

  it('claims before debiting and reserves with a channel-scoped ledger key', async () => {
    const record = turn('reserving');
    const events: string[] = [];
    const persistence = store({
      claimTurn: vi.fn(async () => {
        events.push('claim');
        return record;
      }),
      markReserved: vi.fn(async () => {
        events.push('reserved');
      }),
    });
    const manna = ledger();
    manna.debit = vi.fn(async (_account, _amount, key) => {
      events.push(`debit:${key}`);
      return ledgerResult();
    });

    const result = await new ChannelTurnMeteringService(persistence, manna).reserve({
      turnId: record.turnId,
      connectionId: connection.connectionId,
      runtimeAccountId: connection.runtimeAccountId,
      sessionId: record.sessionId,
      externalMessageId: record.externalMessageId,
    });

    expect(events).toEqual([
      'claim',
      `debit:${channelTurnLedgerKey(record.turnId)}`,
      'reserved',
    ]);
    expect(result.turn).toMatchObject({
      status: 'reserved',
      model: connection.model,
      agentRuntime: connection.agentRuntime,
      pricingBasis: connection.pricingBasis,
    });
  });

  it('does not debit a replayed reservation', async () => {
    const record = turn('reserved');
    const persistence = store({ claimTurn: vi.fn(async () => record) });
    const manna = ledger();
    const service = new ChannelTurnMeteringService(persistence, manna);
    await expect(
      service.reserve({
        turnId: record.turnId,
        connectionId: connection.connectionId,
        runtimeAccountId: connection.runtimeAccountId,
        sessionId: record.sessionId,
        externalMessageId: record.externalMessageId,
      }),
    ).resolves.toMatchObject({ replayed: true, balance: null });
    expect(manna.debit).not.toHaveBeenCalled();
  });

  it('leaves a post-debit state-write failure recoverable for the stale reaper', async () => {
    const record = turn('reserving');
    const persistence = store({
      claimTurn: vi.fn(async () => record),
      markReserved: vi.fn(async () => {
        throw new Error('database state write failed');
      }),
    });
    const manna = ledger();
    await expect(
      new ChannelTurnMeteringService(persistence, manna).reserve({
        turnId: record.turnId,
        connectionId: connection.connectionId,
        runtimeAccountId: connection.runtimeAccountId,
        sessionId: record.sessionId,
        externalMessageId: record.externalMessageId,
      }),
    ).rejects.toThrow('database state write failed');
    expect(manna.debit).toHaveBeenCalledOnce();
    expect(persistence.markError).not.toHaveBeenCalled();
  });

  it('rejects runtime-account and replay attribution confusion before charging', async () => {
    const record = turn('reserved');
    const persistence = store({ claimTurn: vi.fn(async () => record) });
    const manna = ledger();
    const service = new ChannelTurnMeteringService(persistence, manna);
    await expect(
      service.reserve({
        turnId: record.turnId,
        connectionId: connection.connectionId,
        runtimeAccountId: 'other-bot',
      }),
    ).rejects.toThrow('channel connection unavailable');
    await expect(
      service.reserve({
        turnId: record.turnId,
        connectionId: connection.connectionId,
        runtimeAccountId: connection.runtimeAccountId,
        sessionId: record.sessionId,
        externalMessageId: 'telegram:different',
      }),
    ).rejects.toThrow('channel turn isolation violation');
    expect(manna.debit).not.toHaveBeenCalled();
  });

  it('settles an exact frozen-model charge and persists frozen provenance', async () => {
    const record = turn('settling');
    const persistence = store({
      claimSettlement: vi.fn(async () => ({ turn: record, claimed: true })),
    });
    const manna = ledger();
    const usage = {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      totalTokens: 2_000_000,
    };

    const result = await new ChannelTurnMeteringService(persistence, manna).settle(
      record.turnId,
      usage,
      execution,
    );

    expect(result.metering.status).toBe('metered');
    expect(result.chargedManna).toBeGreaterThan(record.reservedManna);
    expect(manna.debit).toHaveBeenCalledWith(
      record.accountId,
      result.chargedManna - record.reservedManna,
      channelTurnSettlementLedgerKey(record.turnId),
    );
    expect(persistence.settle).toHaveBeenCalledWith(
      record,
      usage,
      expect.objectContaining({ status: 'metered' }),
      result.chargedManna,
    );
  });

  it('keeps a settled charge delivery-pending until the exact native callback', async () => {
    expect(REAPABLE_CHANNEL_TURN_STATUSES).toContain('delivery_pending');
    const record = turn('delivery_pending');
    const persistence = store();
    const service = new ChannelTurnMeteringService(persistence, ledger());

    await service.markDelivered(record.turnId);

    expect(persistence.markDelivered).toHaveBeenCalledWith(record.turnId);
  });

  it('fails closed and refunds both debit keys when capped settlement fails', async () => {
    const record = turn('settling');
    const persistence = store({
      claimSettlement: vi.fn(async () => ({ turn: record, claimed: true })),
      claimRefund: vi.fn(async () => ({
        turnId: record.turnId,
        status: 'refunding' as const,
        claimed: true,
      })),
    });
    const manna = ledger();
    manna.debit = vi.fn(async () => {
      throw new Error('daily cap');
    });
    const usage = {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      totalTokens: 2_000_000,
    };

    await expect(
      new ChannelTurnMeteringService(persistence, manna).settle(
        record.turnId,
        usage,
        execution,
      ),
    ).rejects.toThrow('daily cap');
    expect(manna.refund).toHaveBeenNthCalledWith(1, channelTurnSettlementLedgerKey(record.turnId));
    expect(manna.refund).toHaveBeenNthCalledWith(2, channelTurnLedgerKey(record.turnId));
    expect(persistence.markRefunded).toHaveBeenCalledWith(record.turnId, 'settlement_failed');
    expect(persistence.settle).not.toHaveBeenCalled();
  });

  it('refunds every debit when the atomic usage/state write fails after adjustment', async () => {
    const record = turn('settling');
    const persistence = store({
      claimSettlement: vi.fn(async () => ({ turn: record, claimed: true })),
      claimRefund: vi.fn(async () => ({
        turnId: record.turnId,
        status: 'refunding' as const,
        claimed: true,
      })),
      settle: vi.fn(async () => {
        throw new Error('database unavailable');
      }),
    });
    const manna = ledger();
    const usage = {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      totalTokens: 2_000_000,
    };
    await expect(
      new ChannelTurnMeteringService(persistence, manna).settle(
        record.turnId,
        usage,
        execution,
      ),
    ).rejects.toThrow('database unavailable');
    expect(manna.refund).toHaveBeenCalledWith(channelTurnSettlementLedgerKey(record.turnId));
    expect(manna.refund).toHaveBeenCalledWith(channelTurnLedgerKey(record.turnId));
  });

  it('rejects model/provider/runtime drift and refunds before recording usage', async () => {
    const record = turn('settling');
    const persistence = store({
      claimSettlement: vi.fn(async () => ({ turn: record, claimed: true })),
      claimRefund: vi.fn(async () => ({
        turnId: record.turnId,
        status: 'refunding' as const,
        claimed: true,
      })),
    });
    const manna = ledger();
    await expect(
      new ChannelTurnMeteringService(persistence, manna).settle(
        record.turnId,
        { promptTokens: 10 },
        { ...execution, model: 'claude-opus-4-1' },
      ),
    ).rejects.toBeInstanceOf(ChannelExecutionMismatchError);
    expect(manna.debit).not.toHaveBeenCalled();
    expect(manna.refund).toHaveBeenCalledTimes(2);
    expect(persistence.settle).not.toHaveBeenCalled();
  });

  it('serializes settlement claims and never charges a turn already settling', async () => {
    const record = turn('settling');
    const persistence = store({
      claimSettlement: vi.fn(async () => ({ turn: record, claimed: false })),
    });
    const manna = ledger();
    await expect(
      new ChannelTurnMeteringService(persistence, manna).settle(
        record.turnId,
        { promptTokens: 10 },
        execution,
      ),
    ).rejects.toThrow('not settleable');
    expect(manna.debit).not.toHaveBeenCalled();
    expect(manna.refund).not.toHaveBeenCalled();
  });

  it('claims stale open turns and idempotently refunds reserve and settlement keys', async () => {
    const first = randomUUID();
    const second = randomUUID();
    const persistence = store({ claimStale: vi.fn(async () => [first, second]) });
    const manna = ledger();
    const count = await new ChannelTurnMeteringService(persistence, manna).refundStale({
      olderThanMs: 60_000,
      limit: 2,
    });
    expect(count).toBe(2);
    expect(manna.refund).toHaveBeenCalledTimes(4);
    expect(persistence.markRefunded).toHaveBeenCalledWith(first, 'stale_channel_turn');
    expect(persistence.markRefunded).toHaveBeenCalledWith(second, 'stale_channel_turn');
  });

  it('reaps refunding turns and retries when the refunded-state write fails', async () => {
    expect(REAPABLE_CHANNEL_TURN_STATUSES).toContain('refunding');
    const turnId = randomUUID();
    let status: 'refunding' | 'refunded' = 'refunding';
    let markAttempts = 0;
    const persistence = store({
      claimStale: vi.fn(async () => (status === 'refunding' ? [turnId] : [])),
      markRefunded: vi.fn(async () => {
        markAttempts += 1;
        if (markAttempts === 1) throw new Error('transient state write failure');
        status = 'refunded';
      }),
    });
    const applied = new Set<string>();
    const manna = ledger();
    manna.refund = vi.fn(async (key) => {
      const alreadyApplied = applied.has(key);
      applied.add(key);
      return { ...ledgerResult(), alreadyApplied };
    });
    const service = new ChannelTurnMeteringService(persistence, manna);

    await expect(service.refundStale({ olderThanMs: 60_000 })).resolves.toBe(1);
    expect(status).toBe('refunding');
    expect(persistence.markRefundFailed).not.toHaveBeenCalled();

    await expect(service.refundStale({ olderThanMs: 60_000 })).resolves.toBe(1);
    expect(status).toBe('refunded');
    expect(manna.refund).toHaveBeenCalledTimes(4);
    expect(applied).toEqual(
      new Set([channelTurnSettlementLedgerKey(turnId), channelTurnLedgerKey(turnId)]),
    );
    await expect(service.refundStale({ olderThanMs: 60_000 })).resolves.toBe(0);
  });

  it('refunds a runtime-aborted turn exactly once through the refund claim', async () => {
    const record = turn('refunding');
    const persistence = store({
      claimRefund: vi.fn(async () => ({
        turnId: record.turnId,
        status: 'refunding' as const,
        claimed: true,
      })),
    });
    const manna = ledger();
    await new ChannelTurnMeteringService(persistence, manna).refund(record.turnId);
    expect(manna.refund).toHaveBeenCalledTimes(2);
    expect(persistence.markRefunded).toHaveBeenCalledWith(record.turnId, 'runtime_refund');
  });

  it('compensates a settled turn when assistant delivery fails', async () => {
    const record = turn('settled');
    const persistence = store({
      claimRefund: vi.fn(async () => ({
        turnId: record.turnId,
        status: 'refunding' as const,
        claimed: true,
      })),
    });
    const manna = ledger();
    await new ChannelTurnMeteringService(persistence, manna).refundDeliveryFailure(record.turnId);
    expect(persistence.claimRefund).toHaveBeenCalledWith(record.turnId, false, true);
    expect(manna.refund).toHaveBeenNthCalledWith(
      1,
      channelTurnSettlementLedgerKey(record.turnId),
    );
    expect(manna.refund).toHaveBeenNthCalledWith(2, channelTurnLedgerKey(record.turnId));
    expect(persistence.markRefunded).toHaveBeenCalledWith(
      record.turnId,
      'channel_delivery_failed',
    );
  });

  it('does not let a public refund steal a live settlement claim', async () => {
    const record = turn('settling');
    const persistence = store({
      claimRefund: vi.fn(async () => ({
        turnId: record.turnId,
        status: record.status,
        claimed: false,
      })),
    });
    const manna = ledger();
    await expect(
      new ChannelTurnMeteringService(persistence, manna).refund(record.turnId),
    ).rejects.toThrow('not refundable');
    expect(persistence.claimRefund).toHaveBeenCalledWith(record.turnId);
    expect(manna.refund).not.toHaveBeenCalled();
  });

  it('refunds a quarantined legacy row without requiring invented provenance', async () => {
    const turnId = randomUUID();
    const persistence = store({
      claimRefund: vi.fn(async () => ({
        turnId,
        status: 'refunding' as const,
        claimed: true,
      })),
    });
    const manna = ledger();
    await new ChannelTurnMeteringService(persistence, manna).refund(turnId);
    expect(manna.refund).toHaveBeenNthCalledWith(1, channelTurnSettlementLedgerKey(turnId));
    expect(manna.refund).toHaveBeenNthCalledWith(2, channelTurnLedgerKey(turnId));
    expect(persistence.markRefunded).toHaveBeenCalledWith(turnId, 'runtime_refund');
  });
});
