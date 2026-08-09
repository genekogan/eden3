import {
  debit,
  getEnv,
  mannaFromUsd,
  numericToNumber,
  refundIdempotencyKey,
  reverseReservation,
  settleReservation,
  turnAuthorizedMax,
  type DbHandle,
} from '@eden3/core';
import { db, pg, type PgClient } from '@eden3/db';
import { getModelAgentRuntime, type GatewayUsage } from '@eden3/gateway';
import type { AgentRuntime } from '@eden3/shared';
import { sql } from 'drizzle-orm';

import { meterChatUsage, type ChatTurnMetering } from './turns';
import {
  claimTurnProviderAdmissionInTransaction,
  insertTurnAuthorization,
  markTurnSettled,
  markTurnUsableOutput,
  recordErasureProviderTerminalNoOutput,
} from './turn-authorization';
import { channelRuntimeBindingMatches } from './channel-runtime-binding';

export interface ChannelTurnUsage extends GatewayUsage {
  cacheWriteTokens?: number;
  /** Authoritative OpenRouter `usage.cost` for this whole turn, in USD. */
  providerCostUsd?: number;
}

export type ChannelPricingBasis =
  | 'provider-api'
  | 'notional-subscription'
  | 'provider-reported';
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

export interface ChannelAuthorizationResult {
  balance: number;
  replayed: boolean;
}

export interface ReserveChannelTurnInput {
  turnId: string;
  connectionId: string;
  runtimeAccountId: string;
  agentId?: string;
  bindingId?: string;
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
  errorCode?: string | null;
}

export interface ChannelTurnStoreLike {
  getBillableConnection(
    connectionId: string,
    sessionId?: string | null,
    runtimeBinding?: { agentId?: string; bindingId?: string },
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
  markUsableOutput(turnId: string): Promise<void>;
  markError(turnId: string, errorCode: string): Promise<void>;
  authorize(
    turn: ChannelTurnRecord,
    runtimeBinding?: { agentId?: string; bindingId?: string },
  ): Promise<ChannelAuthorizationResult>;
  settleAuthorized(
    turn: ChannelTurnRecord,
    usage: ChannelTurnUsage | undefined,
    metering: ChatTurnMetering,
    chargedManna: number,
  ): Promise<void>;
  reverseAuthorized(turnId: string, errorCode: string): Promise<void>;
  markRefundFailed(turnId: string, errorCode: string): Promise<void>;
}

interface BillableRow {
  connection_id: string;
  runtime_account_id: string;
  account_id: string;
  agent_id: string;
  channel: 'discord' | 'telegram';
  model: string;
  agent_openclaw_id: string;
  metadata: unknown;
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

function pricingBasisForRuntime(runtime: AgentRuntime, model: string): ChannelPricingBasis {
  if (runtime === 'claude-cli') return 'notional-subscription';
  return model.startsWith('openrouter/') ? 'provider-reported' : 'provider-api';
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
    (row.pricing_basis !== 'provider-api' &&
      row.pricing_basis !== 'notional-subscription' &&
      row.pricing_basis !== 'provider-reported') ||
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
    private readonly applicationDb: DbHandle = db,
    private readonly applicationClient: PgClient = pg,
  ) {}

  async getBillableConnection(
    connectionId: string,
    sessionId?: string | null,
    runtimeBinding?: { agentId?: string; bindingId?: string },
  ): Promise<BillableChannelConnection | null> {
    const rows = await this.applicationClient<BillableRow[]>`
      select c.id as connection_id, c.runtime_account_id, c.account_id,
             c.agent_id, c.channel, a.model, a.openclaw_id as agent_openclaw_id,
             c.metadata
      from channel_connections c
      join agents a on a.account_id = c.agent_id
      join accounts owner_account on owner_account.id = c.account_id
      join accounts agent_account on agent_account.id = c.agent_id
      where c.id = ${connectionId}
        and c.desired_state = 'active'
        and c.runtime_account_id is not null
        and c.agent_id is not null
        and c.channel in ('discord', 'telegram')
        and a.owner_id = c.account_id
        and a.openclaw_id is not null
        and owner_account.type = 'user' and owner_account.deleted = false
        and agent_account.type = 'agent' and agent_account.deleted = false
        and (
          ${sessionId ?? null}::uuid is null
          or exists (
            select 1 from sessions s
            where s.id = ${sessionId ?? null}::uuid
              and s.channel_connection_id = c.id
              and s.owner_id = c.account_id
              and s.session_type = 'channel'
              and s.deleted = false
              and s.visible is distinct from false
              and exists (
                select 1 from session_agents sa
                where sa.session_id = s.id and sa.agent_account_id = c.agent_id
              )
              and not exists (
                select 1 from session_agents sa
                where sa.session_id = s.id and sa.agent_account_id <> c.agent_id
              )
          )
        )
      limit 1
    `;
    const row = rows[0];
    if (
      !row ||
      !channelRuntimeBindingMatches({
        metadata: row.metadata,
        storedAgentId: row.agent_openclaw_id,
        requesterAgentId: runtimeBinding?.agentId,
        requesterBindingId: runtimeBinding?.bindingId,
      })
    ) return null;
    const agentRuntime = await this.runtimeForModel(row.model);
    return {
      connectionId: row.connection_id,
      runtimeAccountId: row.runtime_account_id,
      accountId: row.account_id,
      agentId: row.agent_id,
      channel: row.channel,
      model: row.model,
      agentRuntime,
      pricingBasis: pricingBasisForRuntime(agentRuntime, row.model),
    };
  }

  async claimTurn(
    connection: BillableChannelConnection,
    input: ReserveChannelTurnInput,
    reservedManna: number,
  ): Promise<ChannelTurnRecord> {
    const currentRuntime = await this.runtimeForModel(connection.model);
    if (currentRuntime !== connection.agentRuntime) {
      throw new Error('channel connection unavailable');
    }
    return this.applicationClient.begin(async (tx) => {
      const currentRows = await tx<BillableRow[]>`
        select c.id as connection_id, c.runtime_account_id, c.account_id,
               c.agent_id, c.channel, a.model, a.openclaw_id as agent_openclaw_id,
               c.metadata
        from channel_connections c
        join agents a on a.account_id = c.agent_id
        join accounts owner_account on owner_account.id = c.account_id
        join accounts agent_account on agent_account.id = c.agent_id
        where c.id = ${connection.connectionId}
          and c.desired_state = 'active'
          and c.runtime_account_id is not null
          and c.agent_id is not null
          and c.channel in ('discord', 'telegram')
          and a.owner_id = c.account_id
          and a.openclaw_id is not null
          and owner_account.type = 'user' and owner_account.deleted = false
          and agent_account.type = 'agent' and agent_account.deleted = false
          and (
            ${input.sessionId ?? null}::uuid is null
            or exists (
              select 1 from sessions s
              where s.id = ${input.sessionId ?? null}::uuid
              and s.channel_connection_id = c.id
              and s.owner_id = c.account_id
              and s.session_type = 'channel'
              and s.deleted = false
              and s.visible is distinct from false
              and exists (
                select 1 from session_agents sa
                where sa.session_id = s.id and sa.agent_account_id = c.agent_id
              )
              and not exists (
                select 1 from session_agents sa
                where sa.session_id = s.id and sa.agent_account_id <> c.agent_id
              )
            )
          )
        for update of c
      `;
      const current = currentRows[0];
      if (
        !current ||
        current.connection_id !== connection.connectionId ||
        current.runtime_account_id !== connection.runtimeAccountId ||
        current.account_id !== connection.accountId ||
        current.agent_id !== connection.agentId ||
        current.channel !== connection.channel ||
        current.model !== connection.model ||
        !channelRuntimeBindingMatches({
          metadata: current.metadata,
          storedAgentId: current.agent_openclaw_id,
          requesterAgentId: input.agentId,
          requesterBindingId: input.bindingId,
        })
      ) {
        throw new Error('channel connection unavailable');
      }
      if (input.sessionId) {
        const sessionRows = await tx<{ id: string }[]>`
          select s.id
          from sessions s
          where s.id = ${input.sessionId}
            and s.channel_connection_id = ${connection.connectionId}
            and s.owner_id = ${connection.accountId}
            and s.session_type = 'channel'
            and s.deleted = false
            and s.visible is distinct from false
            and exists (
              select 1 from session_agents sa
              where sa.session_id = s.id and sa.agent_account_id = ${connection.agentId}
            )
            and not exists (
              select 1 from session_agents sa
              where sa.session_id = s.id and sa.agent_account_id <> ${connection.agentId}
            )
          for update of s
        `;
        if (!sessionRows[0]) throw new Error('channel connection unavailable');
      }
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
    const rows = await this.applicationClient<TurnRow[]>`
      select ${TURN_COLUMNS}
      from channel_turns
      where turn_id = ${turnId}
      limit 1
    `;
    return rows[0] ? mapTurn(rows[0]) : null;
  }

  async claimSettlement(turnId: string): Promise<ChannelTurnClaim | null> {
    return this.applicationClient.begin(async (tx) => {
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
    return this.applicationClient.begin(async (tx) => {
      const rows = await tx<{ turn_id: string; status: ChannelTurnStatus; error_code: string | null }[]>`
        select turn_id, status, error_code
        from channel_turns
        where turn_id = ${turnId}
        for update
      `;
      if (!rows[0]) return null;
      const turn = {
        turnId: rows[0].turn_id,
        status: rows[0].status,
        errorCode: rows[0].error_code,
      };
      if (
        ['reserving', 'reserved', 'error'].includes(turn.status) ||
        (allowSettling && turn.status === 'settling') ||
        (allowSettled && turn.status === 'delivery_pending')
      ) {
        await tx`
          update channel_turns
          set status = 'refunding',
              error_code = case
                when status = 'delivery_pending' then 'channel_delivery_compensation_pending'
                else error_code
              end,
              updated_at = now()
          where turn_id = ${turnId}
            and (
              status in ('reserving', 'reserved', 'error')
              or (${allowSettling} and status = 'settling')
              or (${allowSettled} and status = 'delivery_pending')
            )
        `;
        return {
          turnId: turn.turnId,
          status: 'refunding',
          claimed: true,
          errorCode:
            turn.status === 'delivery_pending'
              ? 'channel_delivery_compensation_pending'
              : turn.errorCode,
        };
      }
      return { ...turn, claimed: false };
    });
  }

  async claimStale(cutoff: Date, limit: number): Promise<string[]> {
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    return this.applicationClient.begin(async (tx) => {
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
        set status = 'refunding',
            error_code = case
              when t.status = 'delivery_pending' then 'channel_delivery_compensation_pending'
              when t.status = 'refunding'
                and t.error_code = 'channel_delivery_compensation_pending'
                then t.error_code
              else 'stale_channel_turn'
            end,
            updated_at = now()
        from stale
        where t.turn_id = stale.turn_id
        returning t.turn_id
      `;
      return rows.map((row) => row.turn_id);
    });
  }

  async authorize(
    turn: ChannelTurnRecord,
    runtimeBinding?: { agentId?: string; bindingId?: string },
  ): Promise<ChannelAuthorizationResult> {
    const route = modelIdentity(turn.model);
    return this.applicationDb.transaction(async (tx) => {
      const liveRows = (await tx.execute(sql`
        select c.id as connection_id, c.runtime_account_id, c.account_id,
               c.agent_id, c.channel, a.model, a.openclaw_id as agent_openclaw_id,
               c.metadata
        from channel_connections c
        join agents a on a.account_id = c.agent_id
        join accounts owner_account on owner_account.id = c.account_id
        join accounts agent_account on agent_account.id = c.agent_id
        where c.id = ${turn.connectionId}
          and c.desired_state = 'active'
          and c.runtime_account_id = ${turn.runtimeAccountId}
          and c.account_id = ${turn.accountId}
          and c.agent_id = ${turn.agentId}
          and c.channel = ${turn.channel}
          and a.model = ${turn.model}
          and a.owner_id = c.account_id
          and a.openclaw_id is not null
          and owner_account.type = 'user' and owner_account.deleted = false
          and agent_account.type = 'agent' and agent_account.deleted = false
          and (
            ${turn.sessionId}::uuid is null
            or exists (
              select 1 from sessions s
              where s.id = ${turn.sessionId}::uuid
              and s.channel_connection_id = c.id
              and s.owner_id = c.account_id
              and s.session_type = 'channel'
              and s.deleted = false
              and s.visible is distinct from false
              and exists (
                select 1 from session_agents sa
                where sa.session_id = s.id and sa.agent_account_id = c.agent_id
              )
              and not exists (
                select 1 from session_agents sa
                where sa.session_id = s.id and sa.agent_account_id <> c.agent_id
              )
            )
          )
        for update of c
      `)) as unknown as BillableRow[];
      if (
        !liveRows[0] ||
        !channelRuntimeBindingMatches({
          metadata: liveRows[0].metadata,
          storedAgentId: liveRows[0].agent_openclaw_id,
          requesterAgentId: runtimeBinding?.agentId,
          requesterBindingId: runtimeBinding?.bindingId,
        })
      ) throw new Error('channel connection unavailable');
      if (turn.sessionId) {
        const sessionRows = (await tx.execute(sql`
          select s.id
          from sessions s
          where s.id = ${turn.sessionId}
            and s.channel_connection_id = ${turn.connectionId}
            and s.owner_id = ${turn.accountId}
            and s.session_type = 'channel'
            and s.deleted = false
            and s.visible is distinct from false
            and exists (
              select 1 from session_agents sa
              where sa.session_id = s.id and sa.agent_account_id = ${turn.agentId}
            )
            and not exists (
              select 1 from session_agents sa
              where sa.session_id = s.id and sa.agent_account_id <> ${turn.agentId}
            )
          for update of s
        `)) as unknown as Array<{ id: string }>;
        if (!sessionRows[0]) throw new Error('channel connection unavailable');
      }
      const debited = await debit({
        accountId: turn.accountId,
        amount: turn.reservedManna,
        type: 'spend:chat:channel',
        idempotencyKey: channelTurnLedgerKey(turn.turnId),
        dailyCap: { limit: getEnv().DAILY_MANNA_SPEND_CAP_PER_USER },
        db: tx,
      });
      if (debited.alreadyApplied) {
        const replayChecks = (await tx.execute(sql`
          select
            exists (
              select 1 from manna_accounts
              where id = ${debited.transaction.mannaAccountId}
                and account_id = ${turn.accountId}
            ) as payer_matches,
            exists (
              select 1 from manna_transactions
              where refunds_transaction_id = ${debited.transaction.id}
                and amount > 0
            ) as was_refunded,
            exists (
              select 1 from turn_authorizations
              where turn_id = ${turn.turnId}
                and reservation_tx_id = ${debited.transaction.id}
                and state = 'reserved'
            ) as has_live_authorization
        `)) as unknown as Array<{
          payer_matches: boolean;
          was_refunded: boolean;
          has_live_authorization: boolean;
        }>;
        const replay = replayChecks[0];
        assertChannelReservationReplay({
          recordedAmount: debited.transaction.amount,
          recordedType: debited.transaction.type,
          reservedManna: turn.reservedManna,
          payerMatches: replay?.payer_matches === true,
          wasRefunded: replay?.was_refunded === true,
          hasLiveAuthorization: replay?.has_live_authorization === true,
        });
      }
      const authorization = turnAuthorizedMax(route);
      const row = await insertTurnAuthorization(tx, {
        turnId: turn.turnId,
        accountId: turn.accountId,
        agentAccountId: turn.agentId,
        sessionId: turn.sessionId,
        provider: authorization.provider,
        model: authorization.model,
        pricingBasis: turn.pricingBasis,
        ceilingTableVersion: authorization.tableVersion,
        authorizedMaxManna: authorization.manna,
        reservedSubscriptionManna: debited.subscriptionDrawn ?? 0,
        reservationTxId: debited.transaction.id,
      });
      if (
        !row ||
        numericToNumber(row.authorizedMaxManna) !== turn.reservedManna ||
        row.agentAccountId !== turn.agentId ||
        row.sessionId !== turn.sessionId ||
        row.ceilingTableVersion !== authorization.tableVersion
      ) {
        throw new Error('channel turn authorization conflict');
      }
      const updated = (await tx.execute(sql`
        update channel_turns
        set status = 'reserved', error_code = null, updated_at = now()
        where turn_id = ${turn.turnId} and status = 'reserving'
        returning turn_id
      `)) as unknown as { turn_id: string }[];
      if (!updated[0]) throw new Error('channel turn reservation state changed');
      if (!await claimTurnProviderAdmissionInTransaction(tx, turn.turnId, 'channel_chat')) {
        throw new Error('channel turn provider admission was not durably recorded');
      }
      return { balance: debited.balance.total, replayed: debited.alreadyApplied };
    });
  }

  async markDelivered(turnId: string): Promise<void> {
    await this.applicationDb.transaction(async (tx) => {
      const rows = (await tx.execute(sql`
        select status, error_code
        from channel_turns
        where turn_id = ${turnId}
        for update
      `)) as unknown as Array<{ status: ChannelTurnStatus; error_code: string | null }>;
      const turn = rows[0];
      if (turn?.status === 'delivered') return;
      let deliverable = turn?.status === 'delivery_pending';
      if (
        turn?.status === 'refunding' &&
        turn.error_code === 'channel_delivery_compensation_pending'
      ) {
        const reversalRows = (await tx.execute(sql`
          select 1 from manna_transactions
          where idempotency_key = ${refundIdempotencyKey(channelTurnLedgerKey(turnId))}
          limit 1
        `)) as unknown as unknown[];
        // A replayed native-success outbox may beat a claimed stale reversal.
        // The channel row lock serializes this rescue against reverseAuthorized:
        // success wins before the ledger leg, otherwise compensation is final.
        deliverable = reversalRows.length === 0;
      }
      if (!deliverable) {
        if (
          turn?.status === 'refunded' ||
          (turn?.status === 'refunding' &&
            turn.error_code === 'channel_delivery_compensation_pending')
        ) {
          throw new ChannelDeliveryTerminalCompensatedError();
        }
        throw new Error('channel turn delivery state changed');
      }
      const updated = (await tx.execute(sql`
        update channel_turns
        set status = 'delivered', error_code = null,
            updated_at = now(), completed_at = now()
        where turn_id = ${turnId}
          and (
            status = 'delivery_pending'
            or (
              status = 'refunding'
              and error_code = 'channel_delivery_compensation_pending'
            )
          )
        returning turn_id
      `)) as unknown as Array<{ turn_id: string }>;
      if (!updated[0]) throw new Error('channel turn delivery state changed');
    });
  }

  async markUsableOutput(turnId: string): Promise<void> {
    await markTurnUsableOutput(turnId, { db: this.applicationDb });
  }

  async markError(turnId: string, errorCode: string): Promise<void> {
    await this.applicationClient`
      update channel_turns
      set status = 'error', error_code = ${errorCode}, updated_at = now(), completed_at = now()
      where turn_id = ${turnId} and status = 'reserving'
    `;
  }

  async settleAuthorized(
    turn: ChannelTurnRecord,
    usage: ChannelTurnUsage | undefined,
    metering: ChatTurnMetering,
    chargedManna: number,
  ): Promise<void> {
    const costUsd = metering.costUsd === null ? null : metering.costUsd.toFixed(8);
    await this.applicationDb.transaction(async (tx) => {
      const authRows = (await tx.execute(sql`
        select state, authorized_max_manna, reserved_subscription_manna
        from turn_authorizations
        where turn_id = ${turn.turnId}
        for update
      `)) as unknown as Array<{
        state: string;
        authorized_max_manna: string;
        reserved_subscription_manna: string;
      }>;
      const auth = authRows[0];
      if (
        !auth ||
        auth.state !== 'reserved' ||
        numericToNumber(auth.authorized_max_manna) !== turn.reservedManna ||
        chargedManna > turn.reservedManna
      ) {
        throw new Error('channel turn authorization is not settleable');
      }
      await markTurnSettled(tx, turn.turnId, {
        chargedManna,
        overrun: metering.status === 'metered' && metering.manna > turn.reservedManna,
      });
      await settleReservation({
        reservationKey: channelTurnLedgerKey(turn.turnId),
        chargeManna: chargedManna,
        reservedSubscriptionManna: numericToNumber(auth.reserved_subscription_manna),
        type: 'refund:chat:channel:settle',
        db: tx,
      });
      const usageUpdated = (await tx.execute(sql`
        update usage_events set
          status=${metering.status === 'metered' ? 'completed' : metering.status},
          table_version=${metering.status === 'metered' ? metering.tableVersion : null},
          prompt_tokens=${usage?.promptTokens ?? null},
          completion_tokens=${usage?.completionTokens ?? null},
          cached_tokens=${usage?.cachedTokens ?? null},
          cache_write_tokens=${usage?.cacheWriteTokens ?? null},
          total_tokens=${usage?.totalTokens ?? null},cost_usd=${costUsd},manna=${chargedManna},
          metadata=${JSON.stringify({
            channel: turn.channel,
            connectionId: turn.connectionId,
            runtimeAccountId: turn.runtimeAccountId,
            externalMessageId: turn.externalMessageId,
            agentRuntime: turn.agentRuntime,
            pricingBasis: turn.pricingBasis,
            metering,
            authorization: {
              authorizedMaxManna: turn.reservedManna,
              overrun: metering.status === 'metered' && metering.manna > turn.reservedManna,
            },
          })}::jsonb
        where event_type='channel_chat' and turn_id=${turn.turnId}
          and status='provider_admitted' and user_id=${turn.accountId}
          and agent_id=${turn.agentId} and session_id is not distinct from ${turn.sessionId}::uuid
          and provider=${metering.provider} and model=${metering.model}
          and pricing_basis=${turn.pricingBasis}
        returning id
      `)) as unknown as Array<{ id: string }>;
      if (usageUpdated.length !== 1) throw new Error('channel provider usage skeleton changed');
      const updated = (await tx.execute(sql`
        update channel_turns
        set status = 'delivery_pending', metered_manna = ${chargedManna},
            error_code = null, updated_at = now(), completed_at = null
        where turn_id = ${turn.turnId} and status = 'settling'
        returning turn_id
      `)) as unknown as { turn_id: string }[];
      if (!updated[0]) throw new Error('channel turn settlement state changed');
    });
  }

  async reverseAuthorized(turnId: string, errorCode: string): Promise<void> {
    await this.applicationDb.transaction(async (tx) => {
      let terminalErrorCode = errorCode;
      const authRows = (await tx.execute(sql`
        select a.state, a.reserved_subscription_manna,
               t.status as channel_status, t.error_code as channel_error_code
        from turn_authorizations a
        join channel_turns t on t.turn_id = a.turn_id
        where a.turn_id = ${turnId}
        for update
      `)) as unknown as Array<{
        state: string;
        reserved_subscription_manna: string;
        channel_status: string;
        channel_error_code: string | null;
      }>;
      const auth = authRows[0];
      if (auth && (auth.state === 'reserved' || auth.state === 'settled')) {
        const reversalKind = channelAuthorizationReversalKind({
          authorizationState: auth.state,
          channelStatus: auth.channel_status,
          channelErrorCode: auth.channel_error_code,
        });
        if (reversalKind === 'delivery_compensation') {
          // The stale reaper and the explicit delivery-failed callback are
          // two claim paths for the same post-settlement compensation. Keep
          // their terminal channel/usage evidence canonical.
          terminalErrorCode = 'channel_delivery_failed';
        }
        await reverseReservation({
          reservationKey: channelTurnLedgerKey(turnId),
          reservedSubscriptionManna: numericToNumber(auth.reserved_subscription_manna),
          type: 'refund:chat:channel',
          db: tx,
        });
        if (reversalKind === 'pre_settlement') {
          await tx.execute(sql`
            update turn_authorizations
            set state = 'reversed', charged_manna = 0, updated_at = now()
            where turn_id = ${turnId} and state = 'reserved'
          `);
        }
      } else if (!auth) {
        // Pre-kernel recovery only. New channel reservations always carry an
        // authorization row; a historical flat reservation must still not be
        // stranded when the first post-upgrade reaper sees it.
        const legacyDebits = (await tx.execute(sql`
          select 1 from manna_transactions
          where idempotency_key = ${channelTurnLedgerKey(turnId)}
          limit 1
        `)) as unknown as unknown[];
        if (legacyDebits.length > 0) {
          await reverseReservation({
            reservationKey: channelTurnLedgerKey(turnId),
            type: 'refund:chat:channel:legacy',
            db: tx,
          });
        }
      }
      const updated = (await tx.execute(sql`
        update channel_turns
        set status = 'refunded', metered_manna = 0,
            error_code = ${terminalErrorCode}, updated_at = now(), completed_at = now()
        where turn_id = ${turnId} and status = 'refunding'
        returning turn_id
      `)) as unknown as { turn_id: string }[];
      if (updated[0]) {
        // A post-settlement delivery failure is still a zero-charge terminal
        // result. Keep the billing audit row aligned with the compensated
        // ledger instead of leaving a misleading completed/charged event.
        await tx.execute(sql`
          update usage_events
          set status = 'error', manna = 0, error_code = ${terminalErrorCode},
              error_message = case
                when ${terminalErrorCode} = 'channel_delivery_failed'
                  then 'Channel reply delivery failed after provider completion; charge refunded'
                else error_message
              end
          where event_type = 'channel_chat' and turn_id = ${turnId}
        `);
      }
    });
  }

  async markRefundFailed(turnId: string, errorCode: string): Promise<void> {
    await this.applicationClient`
      update channel_turns
      set status = case
            when error_code = 'channel_delivery_compensation_pending' then 'refunding'
            else 'error'
          end,
          error_code = case
            when error_code = 'channel_delivery_compensation_pending' then error_code
            else ${errorCode}
          end,
          updated_at = now(), completed_at = null
      where turn_id = ${turnId} and status = 'refunding'
    `;
  }
}

export function channelTurnLedgerKey(turnId: string): string {
  return `channel:${turnId}`;
}

export function assertChannelReservationReplay(input: {
  recordedAmount: string | null;
  recordedType: string | null;
  reservedManna: number;
  payerMatches: boolean;
  wasRefunded: boolean;
  hasLiveAuthorization: boolean;
}): void {
  if (
    input.recordedAmount === null ||
    -numericToNumber(input.recordedAmount) !== input.reservedManna ||
    input.recordedType !== 'spend:chat:channel' ||
    !input.payerMatches ||
    input.wasRefunded ||
    !input.hasLiveAuthorization
  ) {
    throw new Error('channel turn reservation replay conflict');
  }
}

export function channelAuthorizationReversalKind(input: {
  authorizationState: string;
  channelStatus: string;
  channelErrorCode: string | null;
}): 'pre_settlement' | 'delivery_compensation' {
  if (input.authorizationState === 'reserved') return 'pre_settlement';
  if (
    input.authorizationState === 'settled' &&
    input.channelStatus === 'refunding' &&
    input.channelErrorCode === 'channel_delivery_compensation_pending'
  ) {
    return 'delivery_compensation';
  }
  throw new Error('authorization is not reversible for this channel state');
}

export class ChannelExecutionMismatchError extends Error {
  readonly code = 'channel_execution_mismatch';

  constructor(message = 'Provider execution did not match the reserved channel model') {
    super(message);
    this.name = 'ChannelExecutionMismatchError';
  }
}

export class ChannelDeliveryTerminalCompensatedError extends Error {
  readonly code = 'channel_turn_terminal_compensated';

  constructor() {
    super('channel turn was already terminal-compensated');
    this.name = 'ChannelDeliveryTerminalCompensatedError';
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

/**
 * Channel cost-basis adapter. Direct provider API and subscription turns use
 * the frozen token price table; OpenRouter uses its authoritative whole-turn
 * `usage.cost` so reconciliation never substitutes an estimate for the bill.
 */
export function meterChannelUsage(
  usage: ChannelTurnUsage | undefined,
  model: string,
): ChatTurnMetering {
  if (!model.startsWith('openrouter/')) return meterChatUsage(usage, model);
  const providerCostUsd = usage?.providerCostUsd;
  if (
    providerCostUsd === undefined ||
    !Number.isFinite(providerCostUsd) ||
    providerCostUsd < 0
  ) {
    return {
      status: 'missing_usage',
      provider: 'openrouter',
      model: model.slice('openrouter/'.length),
      modelSource: 'agent',
      costUsd: null,
      manna: null,
    };
  }
  return {
    status: 'metered',
    provider: 'openrouter',
    model: model.slice('openrouter/'.length),
    modelSource: 'agent',
    tableVersion: 'openrouter-usage.cost-v1',
    costUsd: providerCostUsd,
    manna: mannaFromUsd(providerCostUsd),
    estimated: false,
    lineItems: [
      {
        unit: 'provider-reported-turn',
        quantity: 1,
        usdPerUnit: providerCostUsd,
        costUsd: providerCostUsd,
      },
    ],
  };
}

export class ChannelTurnMeteringService {
  constructor(
    private readonly store: ChannelTurnStoreLike = new PostgresChannelTurnStore(),
    private readonly providerEvidenceDb: DbHandle = db,
  ) {}

  async reserve(input: ReserveChannelTurnInput): Promise<{
    turn: ChannelTurnRecord;
    balance: number | null;
    replayed: boolean;
  }> {
    const connection = await this.store.getBillableConnection(
      input.connectionId,
      input.sessionId,
      { agentId: input.agentId, bindingId: input.bindingId },
    );
    if (!connection || connection.runtimeAccountId !== input.runtimeAccountId) {
      throw new Error('channel connection unavailable');
    }
    const route = modelIdentity(connection.model);
    const authorization = turnAuthorizedMax(route);
    let turn = await this.store.claimTurn(connection, input, authorization.manna);
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
      // An authorization is one provider ticket, not a reusable balance
      // receipt. A repeated native run id must never get provider permission
      // against the same debit (the channel form of DEBT-004).
      throw new Error('channel turn reservation replay denied');
    }
    if (turn.status !== 'reserving') throw new Error('channel turn is not reservable');
    try {
      const authorized = await this.store.authorize(turn, {
        agentId: input.agentId,
        bindingId: input.bindingId,
      });
      turn = { ...turn, status: 'reserved' };
      return {
        turn,
        balance: authorized.balance,
        replayed: authorized.replayed,
      };
    } catch (error) {
      await this.store.markError(turn.turnId, 'reserve_failed');
      throw error;
    }
  }

  private async refundClaimedTurn(turnId: string, reason: string): Promise<void> {
    try {
      await this.store.reverseAuthorized(turnId, reason);
    } catch (error) {
      await this.store.markRefundFailed(turnId, `${reason}_refund_failed`);
      throw error;
    }
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
    const observed = await this.store.getTurn(turnId);
    if (!observed) throw new Error('channel turn unavailable');
    try {
      assertChannelExecutionMatches(observed, execution);
    } catch (error) {
      await this.refund(turnId);
      throw error;
    }
    // Trusted usable output is durable before any settlement-state mutation.
    // If Tx1 has frozen that later mutation, recovery still charges exactly.
    await this.store.markUsableOutput(turnId);
    const claim = await this.store.claimSettlement(turnId);
    if (!claim) throw new Error('channel turn unavailable');
    const turn = claim.turn;
    if (
      !claim.claimed &&
      (turn.status === 'settled' ||
        turn.status === 'delivery_pending' ||
        turn.status === 'delivered')
    ) {
      const metering = meterChannelUsage(usage, turn.model);
      return { chargedManna: turn.meteredManna ?? turn.reservedManna, metering };
    }
    if (!claim.claimed || turn.status !== 'settling') {
      throw new Error('channel turn is not settleable');
    }

    const metering = meterChannelUsage(usage, turn.model);
    const chargedManna =
      metering.status === 'metered'
        ? Math.min(metering.manna, turn.reservedManna)
        : turn.reservedManna;
    try {
      await this.store.settleAuthorized(turn, usage, metering, chargedManna);
    } catch (error) {
      return this.failSettlement(turn, 'settlement_failed', error);
    }
    return { chargedManna, metering };
  }

  async refund(turnId: string): Promise<void> {
    let claim: Awaited<ReturnType<ChannelTurnStoreLike['claimRefund']>>;
    try {
      claim = await this.store.claimRefund(turnId);
    } catch (error) {
      if (await recordErasureProviderTerminalNoOutput(turnId, { db: this.providerEvidenceDb })) return;
      throw error;
    }
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
   * Unlike the ordinary pre-settlement refund path, this method may claim only
   * the channel consumer's `delivery_pending` state. The authorization row
   * remains terminal at `settled`; its exact ledger charge is compensated once.
   */
  async refundDeliveryFailure(turnId: string): Promise<void> {
    const claim = await this.store.claimRefund(turnId, false, true);
    if (!claim) throw new Error('channel turn unavailable');
    if (claim.status === 'refunded' && claim.errorCode === 'channel_delivery_failed') return;
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
