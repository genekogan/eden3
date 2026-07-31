import { PRICING, debit, getEnv, refund, type LedgerResult } from '@eden3/core';
import { pg } from '@eden3/db';
import { getModelAgentRuntime, type GatewayUsage } from '@eden3/gateway';
import type { AgentRuntime } from '@eden3/shared';

import { meterChatUsage, type ChatTurnMetering } from './turns';

export interface ChannelTurnUsage extends GatewayUsage {
  cacheWriteTokens?: number;
}

export type ChannelPricingBasis = 'provider-api' | 'notional-subscription';
export type ChannelTurnProvenance = 'frozen' | 'recovered_usage_event';

export interface ChannelExecutionReport {
  /** Provider reported by the trusted llm_output hook. */
  provider: string;
  /** Provider model id; a provider-prefixed Eden model id is also accepted. */
  model: string;
  agentRuntime: AgentRuntime;
}

export interface BillableChannelConnection {
  connectionId: string;
  runtimeAccountId: string;
  accountId: string;
  agentId: string;
  channel: 'discord' | 'telegram';
  model: string;
  agentRuntime: AgentRuntime;
  pricingBasis: ChannelPricingBasis;
}

export type ChannelTurnStatus =
  | 'reserving'
  | 'reserved'
  | 'settling'
  | 'refunding'
  | 'settled'
  | 'delivery_pending'
  | 'delivered'
  | 'refunded'
  | 'error';

export const REAPABLE_CHANNEL_TURN_STATUSES: readonly ChannelTurnStatus[] = Object.freeze([
  'reserving',
  'reserved',
  'settling',
  'delivery_pending',
  'refunding',
  'error',
]);

export interface ChannelTurnRecord extends BillableChannelConnection {
  turnId: string;
  sessionId: string | null;
  externalMessageId: string | null;
  status: ChannelTurnStatus;
  reservedManna: number;
  meteredManna: number | null;
  provenanceStatus: ChannelTurnProvenance;
}

export interface ReserveChannelTurnInput {
  turnId: string;
  connectionId: string;
  runtimeAccountId: string;
  sessionId?: string | null;
  externalMessageId?: string | null;
}

export interface ChannelTurnClaim {
  turn: ChannelTurnRecord;
  claimed: boolean;
}

export interface ChannelRefundClaim {
  turnId: string;
  status: ChannelTurnStatus;
  claimed: boolean;
}

export interface ChannelTurnStoreLike {
  getBillableConnection(
    connectionId: string,
    sessionId?: string | null,
  ): Promise<BillableChannelConnection | null>;
  claimTurn(
    connection: BillableChannelConnection,
    input: ReserveChannelTurnInput,
    reservedManna: number,
  ): Promise<ChannelTurnRecord>;
  getTurn(turnId: string): Promise<ChannelTurnRecord | null>;
  claimSettlement(turnId: string): Promise<ChannelTurnClaim | null>;
  claimRefund(
    turnId: string,
    allowSettling?: boolean,
    allowSettled?: boolean,
  ): Promise<ChannelRefundClaim | null>;
  claimStale(cutoff: Date, limit: number): Promise<string[]>;
  markDelivered(turnId: string): Promise<void>;
  markReserved(turnId: string): Promise<void>;
  markError(turnId: string, errorCode: string): Promise<void>;
  settle(
    turn: ChannelTurnRecord,
    usage: ChannelTurnUsage | undefined,
    metering: ChatTurnMetering,
    chargedManna: number,
  ): Promise<void>;
  markRefunded(turnId: string, errorCode?: string | null): Promise<void>;
  markRefundFailed(turnId: string, errorCode: string): Promise<void>;
}

interface BillableRow {
  connection_id: string;
  runtime_account_id: string;
  account_id: string;
  agent_id: string;
  channel: 'discord' | 'telegram';
  model: string;
}

interface TurnRow {
  turn_id: string;
  connection_id: string | null;
  runtime_account_id: string | null;
  account_id: string | null;
  agent_id: string | null;
  channel: string | null;
  model: string | null;
  agent_runtime: string | null;
  pricing_basis: string | null;
  provenance_status: string;
  session_id: string | null;
  external_message_id: string | null;
  status: ChannelTurnStatus;
  reserved_manna: number;
  metered_manna: number | null;
}

function pricingBasisForRuntime(runtime: AgentRuntime): ChannelPricingBasis {
  return runtime === 'claude-cli' ? 'notional-subscription' : 'provider-api';
}

export function isBillableChannelTurnProvenance(
  value: string,
): value is ChannelTurnProvenance {
  return value === 'frozen' || value === 'recovered_usage_event';
}

function mapTurn(row: TurnRow): ChannelTurnRecord {
  if (
    !row.connection_id ||
    !row.runtime_account_id ||
    !row.account_id ||
    !row.agent_id ||
    (row.channel !== 'discord' && row.channel !== 'telegram') ||
    !row.model ||
    (row.agent_runtime !== 'openclaw' && row.agent_runtime !== 'claude-cli') ||
    (row.pricing_basis !== 'provider-api' && row.pricing_basis !== 'notional-subscription') ||
    !isBillableChannelTurnProvenance(row.provenance_status)
  ) {
    throw new Error('channel turn provenance unavailable');
  }
  return {
    turnId: row.turn_id,
    connectionId: row.connection_id,
    runtimeAccountId: row.runtime_account_id,
    accountId: row.account_id,
    agentId: row.agent_id,
    channel: row.channel,
    model: row.model,
    agentRuntime: row.agent_runtime,
    pricingBasis: row.pricing_basis,
    provenanceStatus: row.provenance_status,
    sessionId: row.session_id,
    externalMessageId: row.external_message_id,
    status: row.status,
    reservedManna: row.reserved_manna,
    meteredManna: row.metered_manna,
  };
}

const TURN_COLUMNS = pg`
  turn_id, connection_id, runtime_account_id, account_id, agent_id, channel,
  model, agent_runtime, pricing_basis, provenance_status, session_id, external_message_id,
  status, reserved_manna, metered_manna
`;

export class PostgresChannelTurnStore implements ChannelTurnStoreLike {
  constructor(
    private readonly runtimeForModel: (model: string) => Promise<AgentRuntime> = (model) =>
      getModelAgentRuntime(model),
  ) {}

  async getBillableConnection(
    connectionId: string,
    sessionId?: string | null,
  ): Promise<BillableChannelConnection | null> {
    const rows = await pg<BillableRow[]>`
      select c.id as connection_id, c.runtime_account_id, c.account_id,
             c.agent_id, c.channel, a.model
      from channel_connections c
      join agents a on a.account_id = c.agent_id
      where c.id = ${connectionId}
        and c.desired_state = 'active'
        and c.runtime_account_id is not null
        and c.agent_id is not null
        and c.channel in ('discord', 'telegram')
        and (
          ${sessionId ?? null}::uuid is null
          or exists (
            select 1 from sessions s
            where s.id = ${sessionId ?? null}::uuid
              and s.channel_connection_id = c.id
          )
        )
      limit 1
    `;
    const row = rows[0];
    if (!row) return null;
    const agentRuntime = await this.runtimeForModel(row.model);
    return {
      connectionId: row.connection_id,
      runtimeAccountId: row.runtime_account_id,
      accountId: row.account_id,
      agentId: row.agent_id,
      channel: row.channel,
      model: row.model,
      agentRuntime,
      pricingBasis: pricingBasisForRuntime(agentRuntime),
    };
  }

  async claimTurn(
    connection: BillableChannelConnection,
    input: ReserveChannelTurnInput,
    reservedManna: number,
  ): Promise<ChannelTurnRecord> {
    return pg.begin(async (tx) => {
      await tx`
        insert into channel_turns (
          turn_id, connection_id, account_id, agent_id, session_id,
          external_message_id, status, reserved_manna, channel,
          runtime_account_id, model, agent_runtime, pricing_basis, provenance_status
        ) values (
          ${input.turnId}, ${connection.connectionId}, ${connection.accountId},
          ${connection.agentId}, ${input.sessionId ?? null},
          ${input.externalMessageId ?? null}, 'reserving', ${reservedManna},
          ${connection.channel}, ${connection.runtimeAccountId}, ${connection.model},
          ${connection.agentRuntime}, ${connection.pricingBasis}, 'frozen'
        )
        on conflict (turn_id) do nothing
      `;
      const rows = await tx<TurnRow[]>`
        select ${TURN_COLUMNS}
        from channel_turns
        where turn_id = ${input.turnId}
        for update
      `;
      if (!rows[0]) throw new Error('channel turn unavailable');
      return mapTurn(rows[0]);
    });
  }

  async getTurn(turnId: string): Promise<ChannelTurnRecord | null> {
    const rows = await pg<TurnRow[]>`
      select ${TURN_COLUMNS}
      from channel_turns
      where turn_id = ${turnId}
      limit 1
    `;
    return rows[0] ? mapTurn(rows[0]) : null;
  }

  async claimSettlement(turnId: string): Promise<ChannelTurnClaim | null> {
    return pg.begin(async (tx) => {
      const rows = await tx<TurnRow[]>`
        select ${TURN_COLUMNS}
        from channel_turns
        where turn_id = ${turnId}
        for update
      `;
      if (!rows[0]) return null;
      const turn = mapTurn(rows[0]);
      if (turn.status === 'reserved') {
        await tx`
          update channel_turns
          set status = 'settling', updated_at = now()
          where turn_id = ${turnId} and status = 'reserved'
        `;
        return { turn: { ...turn, status: 'settling' }, claimed: true };
      }
      return { turn, claimed: false };
    });
  }

  async claimRefund(
    turnId: string,
    allowSettling = false,
    allowSettled = false,
  ): Promise<ChannelRefundClaim | null> {
    return pg.begin(async (tx) => {
      const rows = await tx<{ turn_id: string; status: ChannelTurnStatus }[]>`
        select turn_id, status
        from channel_turns
        where turn_id = ${turnId}
        for update
      `;
      if (!rows[0]) return null;
      const turn = { turnId: rows[0].turn_id, status: rows[0].status };
      if (
        ['reserving', 'reserved', 'error'].includes(turn.status) ||
        (allowSettling && turn.status === 'settling') ||
        (allowSettled && ['settled', 'delivery_pending'].includes(turn.status))
      ) {
        await tx`
          update channel_turns
          set status = 'refunding', updated_at = now()
          where turn_id = ${turnId}
            and (
              status in ('reserving', 'reserved', 'error')
              or (${allowSettling} and status = 'settling')
              or (${allowSettled} and status in ('settled', 'delivery_pending'))
            )
        `;
        return { turnId: turn.turnId, status: 'refunding', claimed: true };
      }
      return { ...turn, claimed: false };
    });
  }

  async claimStale(cutoff: Date, limit: number): Promise<string[]> {
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    return pg.begin(async (tx) => {
      const rows = await tx<{ turn_id: string }[]>`
        with stale as (
          select turn_id
          from channel_turns
          where status = any(${[...REAPABLE_CHANNEL_TURN_STATUSES]}::text[])
            and updated_at < ${cutoff.toISOString()}::timestamptz
          order by updated_at, turn_id
          for update skip locked
          limit ${boundedLimit}
        )
        update channel_turns t
        set status = 'refunding', error_code = 'stale_channel_turn', updated_at = now()
        from stale
        where t.turn_id = stale.turn_id
        returning t.turn_id
      `;
      return rows.map((row) => row.turn_id);
    });
  }

  async markReserved(turnId: string): Promise<void> {
    const rows = await pg<{ turn_id: string }[]>`
      update channel_turns
      set status = 'reserved', error_code = null, updated_at = now()
      where turn_id = ${turnId} and status = 'reserving'
      returning turn_id
    `;
    if (!rows[0]) throw new Error('channel turn reservation state changed');
  }

  async markDelivered(turnId: string): Promise<void> {
    const rows = await pg<{ turn_id: string }[]>`
      update channel_turns
      set status = 'delivered', error_code = null,
          updated_at = now(), completed_at = now()
      where turn_id = ${turnId} and status = 'delivery_pending'
      returning turn_id
    `;
    if (rows[0]) return;
    const existing = await pg<{ status: ChannelTurnStatus }[]>`
      select status from channel_turns where turn_id = ${turnId} limit 1
    `;
    if (existing[0]?.status === 'delivered') return;
    throw new Error('channel turn delivery state changed');
  }

  async markError(turnId: string, errorCode: string): Promise<void> {
    await pg`
      update channel_turns
      set status = 'error', error_code = ${errorCode}, updated_at = now(), completed_at = now()
      where turn_id = ${turnId} and status = 'reserving'
    `;
  }

  async settle(
    turn: ChannelTurnRecord,
    usage: ChannelTurnUsage | undefined,
    metering: ChatTurnMetering,
    chargedManna: number,
  ): Promise<void> {
    const costUsd = metering.costUsd === null ? null : metering.costUsd.toFixed(8);
    await pg.begin(async (tx) => {
      await tx`
        insert into usage_events (
          event_type, status, user_id, agent_id, session_id, turn_id,
          provider, model, pricing_basis, table_version, prompt_tokens,
          completion_tokens, cached_tokens, cache_write_tokens, total_tokens,
          cost_usd, manna, metadata
        ) values (
          'channel_chat', ${metering.status === 'metered' ? 'completed' : metering.status},
          ${turn.accountId}, ${turn.agentId}, ${turn.sessionId}, ${turn.turnId},
          ${metering.provider}, ${metering.model}, ${turn.pricingBasis},
          ${metering.status === 'metered' ? metering.tableVersion : null},
          ${usage?.promptTokens ?? null}, ${usage?.completionTokens ?? null},
          ${usage?.cachedTokens ?? null}, ${usage?.cacheWriteTokens ?? null},
          ${usage?.totalTokens ?? null}, ${costUsd}, ${chargedManna},
          ${tx.json(JSON.stringify({
            channel: turn.channel,
            connectionId: turn.connectionId,
            runtimeAccountId: turn.runtimeAccountId,
            externalMessageId: turn.externalMessageId,
            agentRuntime: turn.agentRuntime,
            pricingBasis: turn.pricingBasis,
            metering,
          }))}
        )
        on conflict (event_type, turn_id) where turn_id is not null do nothing
      `;
      const updated = await tx<{ turn_id: string }[]>`
        update channel_turns
        set status = 'delivery_pending', metered_manna = ${chargedManna},
            error_code = null, updated_at = now(), completed_at = null
        where turn_id = ${turn.turnId} and status = 'settling'
        returning turn_id
      `;
      if (!updated[0]) throw new Error('channel turn settlement state changed');
    });
  }

  async markRefunded(turnId: string, errorCode: string | null = null): Promise<void> {
    const rows = await pg.begin(async (tx) => {
      const updated = await tx<{ turn_id: string }[]>`
        update channel_turns
        set status = 'refunded', metered_manna = 0,
            error_code = ${errorCode}, updated_at = now(), completed_at = now()
        where turn_id = ${turnId} and status = 'refunding'
        returning turn_id
      `;
      if (updated[0]) {
        // A post-settlement delivery failure is still a zero-charge terminal
        // result. Keep the billing audit row aligned with the compensated
        // ledger instead of leaving a misleading completed/charged event.
        await tx`
          update usage_events
          set status = 'error', manna = 0, error_code = ${errorCode},
              error_message = case
                when ${errorCode} = 'channel_delivery_failed'
                  then 'Channel reply delivery failed after provider completion; charge refunded'
                else error_message
              end
          where event_type = 'channel_chat' and turn_id = ${turnId}
        `;
      }
      return updated;
    });
    if (!rows[0]) throw new Error('channel turn refund state changed');
  }

  async markRefundFailed(turnId: string, errorCode: string): Promise<void> {
    await pg`
      update channel_turns
      set status = 'error', error_code = ${errorCode}, updated_at = now(), completed_at = null
      where turn_id = ${turnId} and status = 'refunding'
    `;
  }
}

export interface ChannelLedgerLike {
  debit(accountId: string, amount: number, key: string): Promise<LedgerResult>;
  refund(key: string): Promise<LedgerResult | null>;
}

export function channelTurnLedgerKey(turnId: string): string {
  return `channel:${turnId}`;
}

export function channelTurnSettlementLedgerKey(turnId: string): string {
  return `${channelTurnLedgerKey(turnId)}:settle`;
}

export class ChannelExecutionMismatchError extends Error {
  readonly code = 'channel_execution_mismatch';

  constructor(message = 'Provider execution did not match the reserved channel model') {
    super(message);
    this.name = 'ChannelExecutionMismatchError';
  }
}

function modelIdentity(model: string): { provider: string; model: string } {
  const separator = model.indexOf('/');
  if (separator <= 0 || separator === model.length - 1) {
    throw new ChannelExecutionMismatchError('Reserved channel model is not provider-qualified');
  }
  return { provider: model.slice(0, separator), model: model.slice(separator + 1) };
}

export function assertChannelExecutionMatches(
  turn: Pick<ChannelTurnRecord, 'model' | 'agentRuntime'>,
  report: ChannelExecutionReport,
): void {
  const expected = modelIdentity(turn.model);
  const expectedExecutionProvider =
    turn.agentRuntime === 'claude-cli' ? 'claude-cli' : expected.provider;
  const reported = report.model.includes('/')
    ? modelIdentity(report.model)
    : { provider: report.provider, model: report.model };
  if (
    report.provider !== expectedExecutionProvider ||
    reported.provider !== expectedExecutionProvider ||
    reported.model !== expected.model ||
    report.agentRuntime !== turn.agentRuntime
  ) {
    throw new ChannelExecutionMismatchError();
  }
}

export class ChannelTurnMeteringService {
  constructor(
    private readonly store: ChannelTurnStoreLike = new PostgresChannelTurnStore(),
    private readonly ledger: ChannelLedgerLike = {
      debit: (accountId, amount, key) =>
        debit({
          accountId,
          amount,
          type: 'spend:chat:channel',
          idempotencyKey: key,
          dailyCap: { limit: getEnv().DAILY_MANNA_SPEND_CAP_PER_USER },
        }),
      refund: (key) =>
        refund({ originalIdempotencyKey: key, type: 'refund:chat:channel' }),
    },
  ) {}

  async reserve(input: ReserveChannelTurnInput): Promise<{
    turn: ChannelTurnRecord;
    balance: number | null;
    replayed: boolean;
  }> {
    const connection = await this.store.getBillableConnection(
      input.connectionId,
      input.sessionId,
    );
    if (!connection || connection.runtimeAccountId !== input.runtimeAccountId) {
      throw new Error('channel connection unavailable');
    }
    let turn = await this.store.claimTurn(connection, input, PRICING.chatTurn);
    if (
      turn.connectionId !== connection.connectionId ||
      turn.accountId !== connection.accountId ||
      turn.agentId !== connection.agentId ||
      turn.runtimeAccountId !== connection.runtimeAccountId ||
      turn.channel !== connection.channel ||
      turn.sessionId !== (input.sessionId ?? null) ||
      turn.externalMessageId !== (input.externalMessageId ?? null)
    ) {
      throw new Error('channel turn isolation violation');
    }
    if (
      turn.status === 'reserved' ||
      turn.status === 'settled' ||
      turn.status === 'delivery_pending' ||
      turn.status === 'delivered'
    ) {
      return { turn, balance: null, replayed: true };
    }
    if (turn.status !== 'reserving') throw new Error('channel turn is not reservable');
    let charged: LedgerResult;
    try {
      charged = await this.ledger.debit(
        turn.accountId,
        turn.reservedManna,
        channelTurnLedgerKey(turn.turnId),
      );
    } catch (error) {
      await this.store.markError(turn.turnId, 'reserve_failed');
      throw error;
    }
    // A crash here leaves `reserving`; the stale reaper or an idempotent retry
    // completes/refunds the already-recorded ledger debit.
    await this.store.markReserved(turn.turnId);
    turn = { ...turn, status: 'reserved' };
    return { turn, balance: charged.balance.total, replayed: charged.alreadyApplied };
  }

  private async refundClaimedTurn(turnId: string, reason: string): Promise<void> {
    let firstError: unknown;
    for (const key of [
      channelTurnSettlementLedgerKey(turnId),
      channelTurnLedgerKey(turnId),
    ]) {
      try {
        await this.ledger.refund(key);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) {
      await this.store.markRefundFailed(turnId, `${reason}_refund_failed`);
      throw firstError;
    }
    await this.store.markRefunded(turnId, reason);
  }

  private async failSettlement(turn: ChannelTurnRecord, reason: string, cause: unknown): Promise<never> {
    // This service owns the preceding `settling` claim, so it may atomically
    // convert that state to a refund. The public refund path cannot steal a
    // live settlement and race a later adjustment debit.
    const claimed = await this.store.claimRefund(turn.turnId, true);
    if (!claimed?.claimed || claimed.status !== 'refunding') {
      throw new Error('channel turn could not enter fail-closed refund state', { cause });
    }
    try {
      await this.refundClaimedTurn(turn.turnId, reason);
    } catch (refundError) {
      throw new Error('channel settlement failed and refund requires retry', {
        cause: refundError,
      });
    }
    throw cause;
  }

  async settle(
    turnId: string,
    usage: ChannelTurnUsage | undefined,
    execution: ChannelExecutionReport,
  ): Promise<{ chargedManna: number; metering: ChatTurnMetering }> {
    const claim = await this.store.claimSettlement(turnId);
    if (!claim) throw new Error('channel turn unavailable');
    const turn = claim.turn;
    if (
      !claim.claimed &&
      (turn.status === 'settled' ||
        turn.status === 'delivery_pending' ||
        turn.status === 'delivered')
    ) {
      assertChannelExecutionMatches(turn, execution);
      const metering = meterChatUsage(usage, turn.model);
      return { chargedManna: turn.meteredManna ?? turn.reservedManna, metering };
    }
    if (!claim.claimed || turn.status !== 'settling') {
      throw new Error('channel turn is not settleable');
    }

    try {
      assertChannelExecutionMatches(turn, execution);
    } catch (error) {
      return this.failSettlement(turn, 'execution_mismatch', error);
    }

    const metering = meterChatUsage(usage, turn.model);
    const chargedManna = metering.status === 'metered' ? metering.manna : turn.reservedManna;
    const adjustment = chargedManna - turn.reservedManna;
    try {
      if (adjustment > 0) {
        await this.ledger.debit(
          turn.accountId,
          adjustment,
          channelTurnSettlementLedgerKey(turn.turnId),
        );
      } else if (adjustment < 0) {
        // Prices are integer-ceiled, so reserve=1 normally only adjusts to
        // zero. Full linked refund releases cap headroom correctly; if future
        // pricing permits a positive value below the reserve, re-debit the
        // exact amount under the settlement key.
        await this.ledger.refund(channelTurnLedgerKey(turn.turnId));
        if (chargedManna > 0) {
          await this.ledger.debit(
            turn.accountId,
            chargedManna,
            channelTurnSettlementLedgerKey(turn.turnId),
          );
        }
      }
      await this.store.settle(turn, usage, metering, chargedManna);
    } catch (error) {
      return this.failSettlement(turn, 'settlement_failed', error);
    }
    return { chargedManna, metering };
  }

  async refund(turnId: string): Promise<void> {
    const claim = await this.store.claimRefund(turnId);
    if (!claim) throw new Error('channel turn unavailable');
    if (claim.status === 'settled') throw new Error('settled channel turn cannot be refunded');
    if (claim.status === 'refunded') return;
    if (claim.claimed && claim.status === 'refunding') {
      await this.refundClaimedTurn(claim.turnId, 'runtime_refund');
      return;
    }
    throw new Error('channel turn is not refundable');
  }

  /**
   * Compensate a provider-complete turn whose reply could not be synchronized
   * or delivered. The runtime calls this before suppressing outward output.
   * Unlike the ordinary pre-settlement refund path, this method may claim a
   * settled turn and reverses both reservation and adjustment ledger entries.
   */
  async refundDeliveryFailure(turnId: string): Promise<void> {
    const claim = await this.store.claimRefund(turnId, false, true);
    if (!claim) throw new Error('channel turn unavailable');
    if (claim.status === 'refunded') return;
    if (claim.claimed && claim.status === 'refunding') {
      await this.refundClaimedTurn(turnId, 'channel_delivery_failed');
      return;
    }
    throw new Error('channel turn delivery failure is not refundable');
  }

  /** Mark the exact native provider callback as successfully delivered. */
  async markDelivered(turnId: string): Promise<void> {
    await this.store.markDelivered(turnId);
  }

  async refundStale(params: { olderThanMs?: number; limit?: number } = {}): Promise<number> {
    const olderThanMs = Math.max(60_000, params.olderThanMs ?? 45 * 60_000);
    const turnIds = await this.store.claimStale(
      new Date(Date.now() - olderThanMs),
      params.limit ?? 100,
    );
    for (const turnId of turnIds) {
      try {
        await this.refundClaimedTurn(turnId, 'stale_channel_turn');
      } catch {
        // Ledger failures move back to `error`; a final markRefunded failure
        // remains `refunding`. Both states are reaper-eligible on a later tick.
        // Continue so one transient failure does not strand the rest of the batch.
      }
    }
    return turnIds.length;
  }
}
