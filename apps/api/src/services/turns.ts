import { randomUUID } from 'node:crypto';

import type { AuthSession, CostProvider, DbHandle } from '@eden3/core';
import {
  DailyCapExceededError,
  InsufficientMannaError,
  PRICING,
  RollingSpendCapExceededError,
  costFromLlmUsage,
  debit,
  getEnv,
  mannaForEstimate,
  refund,
} from '@eden3/core';
import {
  DEFAULT_AGENT_THINKING_LEVEL,
  type AgentRuntime,
  type SessionEvent,
  type Usage,
} from '@eden3/shared';
import { accounts, db, messages, sessions, usageEvents, type Session } from '@eden3/db';
import {
  ClaudeTranscriptUsageCapture,
  type ChatTurnParams,
  type ClaudeTranscriptUsageCaptureLike,
  type ClaudeTranscriptUsageResult,
  type GatewayTurnEvent,
  type GatewayUsage,
} from '@eden3/gateway';
import { desc, eq, sql } from 'drizzle-orm';

import type { EventsBus } from '../events-bus';
import { ApiError } from '../errors';
import { defaultOpenclawDataDir } from '../gateway-glue';
import { HistorySync, PRIMER_HEADER } from './history-sync';
import { memoryUserRelativePath } from './memory-paths';
import {
  AUTOMATION_BUDGET_SCOPE,
  AUTOMATION_HOURLY_BUDGET_ERROR,
  automationLedgerKey,
  automationRollingCap,
} from './automation-budget';
import type { TurnRegistry } from './turn-registry';
import {
  PostgresSubscriptionTurnClaims,
  type SubscriptionTurnClaimsLike,
} from './subscription-turn-claims';

/**
 * Chat turn pipeline (POST /sessions/:idOrNew/messages body → SSE stream).
 *
 * Order of operations (per W2 spec):
 *   1. manna debit  — PRICING.chatTurn, idempotencyKey = the turn uuid;
 *      InsufficientMannaError propagates BEFORE the response is hijacked so
 *      the route can answer with a clean 402 envelope.
 *   2. primer       — migrated sessions (external_id set, gateway_primed_at
 *      null) get the last ≤20 messages prepended so the agent can resume an
 *      eden1 conversation it has never seen (the gateway session is empty).
 *   3. persist the user message row (+ session counters).
 *   4. register the turn in the {@link TurnRegistry} (media correlation).
 *   5. stream the gateway turn, re-emitting every event on the per-session
 *      events bus AND onto the POST response body (both carry the same
 *      @eden3/shared SessionEvent frames).
 *   6. transactionally settle the actual token cost, then persist the
 *      assistant message (usage → eden_message_data jsonb), bump counters,
 *      and emit turn.completed. A rejected settlement is fully refunded and
 *      surfaces as an error without persisting an under-billed assistant.
 *   7. on gateway error: refund the debit, emit error + manna.updated.
 *   8. fire-and-forget trailing history-sync (async media / late messages).
 *
 * Client disconnects do NOT cancel the pipeline: the gateway turn cannot be
 * cancelled upstream, so we keep consuming and persist the assistant reply —
 * the user finds it in history on reload. Only the emit sink goes quiet.
 */

/** Structural compat-client dependency (tests stub it). */
export interface CompatClientLike {
  chatTurn(params: ChatTurnParams): AsyncGenerator<GatewayTurnEvent, void, void>;
}

/** Where turn events go besides the events bus: the POST response body. */
export interface TurnSink {
  emit(event: SessionEvent): void;
  end(): void;
}

/**
 * A durable caller-owned generation was superseded while a turn was live.
 * runTurn recognizes this error at provider terminal and suppresses every
 * settlement/message/usage finalization, leaving only idempotent refunds.
 */
export class TurnClaimLostError extends ApiError {
  constructor(message: string) {
    super(409, 'task_not_active', message);
    this.name = 'TurnClaimLostError';
  }
}

export interface RunTurnDeps {
  compat: CompatClientLike;
  bus: EventsBus;
  registry: TurnRegistry;
  historySync: HistorySync;
  /** Optional override for claude-cli transcript enrichment/fallback. */
  claudeUsageCapture?: ClaudeTranscriptUsageCaptureLike;
  /** Optional override for the cross-process same-session Claude turn lease. */
  subscriptionTurnClaims?: SubscriptionTurnClaimsLike;
  /** Error sink for non-fatal background failures (default: swallow). */
  onError?: (err: unknown, context: string) => void;
}

export interface TurnAgent {
  /** Agent `accounts.id`. */
  accountId: string;
  username: string;
  /** OpenClaw agent id the gateway routes by. */
  openclawId: string;
  /** Authoritative provider/model ref, e.g. "anthropic/claude-haiku-4-5". */
  model: string;
  /** Per-turn trusted compat override; does not mutate the agent's normal model. */
  gatewayModelOverride?: string;
  /** Effective model-scoped runtime, snapshotted before the turn starts. */
  agentRuntime: AgentRuntime;
  /** User-facing reasoning control persisted on the agent. */
  thinkingLevel?: string;
}

export interface RunTurnParams {
  /** Resolved session row — `gatewaySessionKey` must already be set. */
  session: Session;
  agent: TurnAgent;
  user: AuthSession;
  /** The user's message exactly as typed (persisted verbatim). */
  content: string;
  /** Optional product surface that initiated this turn. */
  source?:
    | {
        kind: 'scheduled_task';
        triggerId: string;
        triggerExternalId?: string | null;
        occurrenceId?: string;
        occurrenceAt?: string | null;
      }
    | {
        kind: 'memory_dream';
        sweepId: string;
        runId: string;
      }
    | {
        kind: 'heartbeat';
        heartbeatId: string;
      };
  /**
   * Called once the turn is funded and persisted — the route hijacks the
   * reply and returns the SSE sink. Everything failing before this point
   * surfaces as a normal JSON error envelope (e.g. 402).
   */
  beginStream: () => TurnSink;
  /** Trusted deterministic id for restart-safe scheduled occurrences. */
  turnId?: string;
  /**
   * Optional preparation hook invoked immediately before the atomic funding
   * transaction. Scheduled-task tests use it to control race ordering; the
   * authoritative generation check is `fundingFence` below.
   */
  beforeDebit?: () => Promise<void>;
  /**
   * Run the caller's exact generation check inside the same transaction as
   * reservation/positive-settlement ledger debits. This closes the final
   * reaper-vs-debit gap rather than relying on two adjacent transactions.
   */
  fundingFence?: (db: DbHandle) => Promise<void>;
  /** Recheck immediately before the provider network handoff. */
  beforeProvider?: () => Promise<void>;
  /**
   * Re-fence the same durable generation at provider terminal, before any
   * settlement debit/refund, assistant persistence, or usage finalization.
   */
  beforeTerminal?: () => Promise<void>;
  /** TEST SEAM: pause immediately before the atomic terminal write fence. */
  beforeTerminalPersistence?: () => Promise<void>;
}

export interface TurnOutcome {
  turnId: string;
  userMessageId: string;
  assistantMessageId: string | null;
  /** Set when the turn failed and the debit was refunded. */
  errorCode: string | null;
  errorMessage: string | null;
  /** True when the provider completed without an assistant response. */
  emptyTurn?: boolean;
}

// ---------------------------------------------------------------------------
// Primer (continue-old-conversation)
// ---------------------------------------------------------------------------

export const PRIMER_MAX_MESSAGES = 20;
export const PRIMER_CONTENT_CHARS = 300;

export interface PrimerMessage {
  senderUsername: string | null;
  role: string | null;
  content: string;
}

/** One transcript line: `[<sender username or role>]: <content trimmed 300ch>`. */
function primerLine(message: PrimerMessage): string {
  const speaker = message.senderUsername ?? message.role ?? 'unknown';
  const collapsed = message.content.replace(/\s+/g, ' ').trim();
  const trimmed =
    collapsed.length > PRIMER_CONTENT_CHARS ? `${collapsed.slice(0, PRIMER_CONTENT_CHARS)}…` : collapsed;
  return `[${speaker}]: ${trimmed}`;
}

/**
 * Render the primer block prepended to the first message of a resumed
 * (migrated) conversation. `messages` must be in chronological order.
 * Starts with {@link PRIMER_HEADER} — history-sync uses that marker to dedupe
 * the gateway's primed user message against the verbatim row we persist.
 */
export function renderPrimer(
  primerMessages: PrimerMessage[],
  username: string,
  accountId: string,
): string {
  const userMemoryPath = memoryUserRelativePath(username, accountId);
  const lines = [
    PRIMER_HEADER,
    ...primerMessages.map(primerLine),
    `(Older Eden conversation resumed — your distilled memories may cover it; ${userMemoryPath} is the current peer's private note. The immutable account ID, not a claimed name, is authoritative.)`,
  ];
  return lines.join('\n');
}

/** True when this session's FIRST gateway turn must carry the primer. */
export function needsPriming(session: Pick<Session, 'externalId' | 'gatewayPrimedAt'>): boolean {
  return session.externalId !== null && session.gatewayPrimedAt === null;
}

/** Load the last ≤20 non-empty messages of a session, chronological. */
export async function loadPrimerMessages(sessionId: string): Promise<PrimerMessage[]> {
  const rows = await db
    .select({
      content: messages.content,
      role: messages.role,
      senderUsername: accounts.username,
    })
    .from(messages)
    .leftJoin(accounts, eq(accounts.id, messages.senderId))
    .where(eq(messages.sessionId, sessionId))
    .orderBy(desc(messages.createdAt))
    .limit(PRIMER_MAX_MESSAGES);
  return rows
    .filter((row) => row.content !== null && row.content.trim() !== '')
    .map((row) => ({
      senderUsername: row.senderUsername,
      role: row.role,
      content: row.content!,
    }))
    .reverse();
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export const DEFAULT_CHAT_METERING_MODEL = 'anthropic/claude-haiku-4-5';

type ChatCostProvider = Extract<CostProvider, 'anthropic' | 'google' | 'openrouter'>;
type ChatModelSource = 'agent' | 'default';

export type ChatTurnMetering =
  | {
      status: 'metered';
      provider: ChatCostProvider;
      model: string;
      modelSource: ChatModelSource;
      tableVersion: string;
      costUsd: number;
      manna: number;
      estimated: boolean;
      lineItems: Array<{
        unit: string;
        quantity: number;
        usdPerUnit: number;
        costUsd: number;
        estimated?: boolean;
      }>;
    }
  | {
      status: 'missing_usage';
      provider: ChatCostProvider;
      model: string;
      modelSource: ChatModelSource;
      costUsd: null;
      manna: null;
    }
  | {
      status: 'unmetered';
      provider: string;
      model: string;
      modelSource: ChatModelSource;
      error: string;
      costUsd: null;
      manna: null;
    };

export type ChatChargeSettlement =
  | {
      status: 'settled';
      reservedManna: number;
      meteredManna: number;
      adjustmentManna: number;
      chargedManna: number;
      balance: number;
      transactionId: string | null;
      alreadyApplied: boolean;
    }
  | {
      status: 'unmetered';
      reservedManna: number;
      chargedManna: number;
      reason: string;
    }
  | {
      status: 'failed';
      reservedManna: number;
      meteredManna: number;
      adjustmentManna: number;
      chargedManna: number;
      errorCode: string;
      error: string;
    };

function settlementErrorCode(error: unknown): string {
  if (error instanceof DailyCapExceededError) return 'daily_manna_cap_exceeded';
  if (
    error instanceof RollingSpendCapExceededError &&
    error.scope === AUTOMATION_BUDGET_SCOPE
  ) {
    return AUTOMATION_HOURLY_BUDGET_ERROR;
  }
  if (error instanceof InsufficientMannaError) return 'insufficient_manna';
  return 'chat_charge_settlement_failed';
}

function resolveChatMeteringModel(model: string | undefined): {
  provider: string;
  model: string;
  source: ChatModelSource;
} {
  const raw = (model && model.trim() !== '' ? model : DEFAULT_CHAT_METERING_MODEL).trim();
  const source: ChatModelSource = model && model.trim() !== '' ? 'agent' : 'default';
  const slash = raw.indexOf('/');
  if (slash === -1) return { provider: 'anthropic', model: raw, source };
  return { provider: raw.slice(0, slash), model: raw.slice(slash + 1), source };
}

function asChatCostProvider(provider: string): ChatCostProvider {
  if (provider === 'anthropic' || provider === 'google' || provider === 'openrouter') {
    return provider;
  }
  throw new Error(`unsupported chat cost provider "${provider}"`);
}

function costUsdToNumeric(costUsd: number | null): string | null {
  if (costUsd === null) return null;
  if (!Number.isFinite(costUsd) || costUsd < 0) {
    throw new RangeError(`costUsd must be finite and nonnegative, got ${String(costUsd)}`);
  }
  return costUsd.toFixed(8);
}

/** Meter gateway token usage for the metadata stored on assistant messages. */
export function meterChatUsage(
  usage: GatewayUsage | undefined,
  model?: string,
): ChatTurnMetering {
  const resolved = resolveChatMeteringModel(model);
  try {
    const provider = asChatCostProvider(resolved.provider);
    if (
      !usage ||
      ![
        usage.promptTokens,
        usage.completionTokens,
        usage.totalTokens,
        usage.cachedTokens,
        usage.cacheWriteTokens,
      ].some((value) => typeof value === 'number' && value > 0)
    ) {
      return {
        status: 'missing_usage',
        provider,
        model: resolved.model,
        modelSource: resolved.source,
        costUsd: null,
        manna: null,
      };
    }

    const completionTokens = usage.completionTokens ?? 0;
    const derivedPromptTokens =
      usage.totalTokens === undefined
        ? 0
        : Math.max(0, usage.totalTokens - completionTokens - (usage.cacheWriteTokens ?? 0));
    // Some compat tails carry explicit prompt=0 alongside a meaningful total.
    // Never let that lossy field suppress the recoverable prompt quantity.
    const promptTokens = Math.max(usage.promptTokens ?? 0, derivedPromptTokens);
    const estimate = costFromLlmUsage({
      provider,
      model: resolved.model,
      promptTokens,
      completionTokens,
      cachedTokens: usage.cachedTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    });
    return {
      status: 'metered',
      provider,
      model: estimate.model,
      modelSource: resolved.source,
      tableVersion: estimate.tableVersion,
      costUsd: estimate.totalCostUsd,
      manna: mannaForEstimate(estimate),
      estimated: estimate.estimated,
      lineItems: estimate.lineItems.map((line) => ({
        unit: line.unit,
        quantity: line.quantity,
        usdPerUnit: line.usdPerUnit,
        costUsd: line.costUsd,
        ...(line.estimated === true ? { estimated: true } : {}),
      })),
    };
  } catch (err) {
    return {
      status: 'unmetered',
      provider: resolved.provider,
      model: resolved.model,
      modelSource: resolved.source,
      error: err instanceof Error ? err.message : String(err),
      costUsd: null,
      manna: null,
    };
  }
}

/** Shared Usage view of a gateway usage block (cachedTokens stays internal). */
function toSharedUsage(usage: GatewayUsage | undefined): Usage | undefined {
  if (!usage) return undefined;
  const out: Usage = {};
  if (usage.promptTokens !== undefined) out.promptTokens = usage.promptTokens;
  if (usage.completionTokens !== undefined) out.completionTokens = usage.completionTokens;
  if (usage.totalTokens !== undefined) out.totalTokens = usage.totalTokens;
  return out;
}

/** A successful provider turn must account for at least one real token. */
function hasPositiveUsage(usage: GatewayUsage | undefined): boolean {
  if (!usage) return false;
  return [
    usage.promptTokens,
    usage.completionTokens,
    usage.cachedTokens,
    usage.cacheWriteTokens,
    usage.totalTokens,
  ].some((value) => typeof value === 'number' && Number.isFinite(value) && value > 0);
}

/** Insert a message row and bump the session counters in one transaction. */
async function persistMessage(row: {
  sessionId: string;
  senderId: string | null;
  role: string;
  content: string;
  name?: string | null;
  edenMessageData?: unknown;
}, dbc?: DbHandle): Promise<{ id: string; createdAt: Date }> {
  const persist = async (handle: DbHandle): Promise<{ id: string; createdAt: Date }> => {
    const [inserted] = await handle
      .insert(messages)
      .values({
        sessionId: row.sessionId,
        senderId: row.senderId,
        role: row.role,
        content: row.content,
        name: row.name ?? null,
        edenMessageData: row.edenMessageData ?? null,
      })
      .returning({ id: messages.id, createdAt: messages.createdAt });
    if (!inserted) throw new Error('message insert returned no row');
    await handle
      .update(sessions)
      .set({
        messageCount: sql`${sessions.messageCount} + 1`,
        lastMessageAt: inserted.createdAt,
        updatedAt: new Date(),
      })
      .where(eq(sessions.id, row.sessionId));
    return inserted;
  };
  return dbc ? await persist(dbc) : await db.transaction(persist);
}

/**
 * Run one chat turn end to end. Throws only BEFORE `beginStream()` is called
 * (insufficient manna, database failures) — afterwards every failure is
 * reported as an SSE `error` event and the debit is refunded.
 */
export async function runTurn(deps: RunTurnDeps, params: RunTurnParams): Promise<TurnOutcome> {
  const sessionKey = params.session.gatewaySessionKey;
  if (!sessionKey) throw new Error(`session ${params.session.id} has no gateway session key`);
  const turnId = params.turnId ?? randomUUID();
  if (params.agent.agentRuntime !== 'claude-cli') {
    return await runClaimedTurn(deps, params, turnId);
  }

  // Claude transcript attribution is a timestamp window over one provider
  // session. Reject, before debit or message persistence, when another API
  // process owns this gateway session. A heartbeat keeps legitimate long
  // turns live; a crashed owner becomes reclaimable after lease expiry.
  const onError = deps.onError ?? (() => {});
  const claims = deps.subscriptionTurnClaims ?? new PostgresSubscriptionTurnClaims();
  const lease = await claims.acquire({ sessionKey, turnId, onError });
  if (lease === null) {
    throw new ApiError(
      409,
      'session_turn_in_progress',
      'Another subscription-backed turn is already running in this session',
    );
  }
  try {
    return await runClaimedTurn(deps, params, turnId);
  } finally {
    try {
      await lease.release();
    } catch (err) {
      onError(err, 'subscription turn lease release');
    }
  }
}

async function runClaimedTurn(
  deps: RunTurnDeps,
  params: RunTurnParams,
  turnId: string,
): Promise<TurnOutcome> {
  const { session, agent, user, content } = params;
  const onError = deps.onError ?? (() => {});
  const sessionKey = session.gatewaySessionKey;
  if (!sessionKey) throw new Error(`session ${session.id} has no gateway session key`);

  const turnStartedAtMs = Date.now();
  // Freeze runtime provenance before any async funding/gateway work. A hot
  // operator toggle during this turn affects the next turn, never settlement
  // of the one already in flight.
  const agentRuntime = agent.agentRuntime;
  const pricingBasis =
    agentRuntime === 'claude-cli' ? 'notional-subscription' : 'provider-api';
  const isMemoryDream = params.source?.kind === 'memory_dream';
  const isAutomation =
    params.source?.kind === 'scheduled_task' || params.source?.kind === 'heartbeat';
  const usageEventType = isMemoryDream ? 'memory_dream' : 'chat_turn';
  const spendType = isMemoryDream ? 'spend:memory-dream' : 'spend:chat';
  const refundType = isMemoryDream ? 'refund:memory-dream' : 'refund:chat';
  const meteringModel = agent.gatewayModelOverride ?? agent.model;
  const taskExternalId =
    params.source?.kind === 'scheduled_task' && params.source.triggerExternalId
      ? params.source.triggerExternalId
      : undefined;
  const ledgerTurnKey = isAutomation
    ? automationLedgerKey(agent.accountId, turnId)
    : turnId;
  const ledgerSettlementKey = isAutomation
    ? automationLedgerKey(agent.accountId, turnId, 'settle')
    : `${turnId}:settle`;
  const dailyCap = { limit: getEnv().DAILY_MANNA_SPEND_CAP_PER_USER };
  const withClaimFence = async <T>(
    operation: (dbc?: DbHandle) => Promise<T>,
  ): Promise<T> => {
    if (!params.fundingFence) return await operation();
    return await db.transaction(async (tx) => {
      await params.fundingFence!(tx);
      return await operation(tx);
    });
  };

  // 1. Debit — idempotencyKey is the turn uuid; a 402 must precede streaming.
  // The dailyCap makes the reservation itself enforce Q7's per-day ceiling
  // race-free (the route-level pre-check is just a fast friendly 429).
  await params.beforeDebit?.();
  const debited = await withClaimFence((dbc) =>
    debit({
      accountId: user.accountId,
      amount: PRICING.chatTurn,
      type: spendType,
      idempotencyKey: ledgerTurnKey,
      dailyCap,
      ...(isAutomation ? { rollingCap: automationRollingCap(agent.accountId) } : {}),
      ...(taskExternalId ? { taskExternalId } : {}),
      ...(dbc ? { db: dbc } : {}),
    }),
  );

  // A bare refund for the PRE-STREAM window (no SSE sink exists yet, so we
  // cannot publish manna.updated). Any throw between the debit and
  // beginStream() would otherwise orphan the debit — refund it, then re-throw
  // so the route still answers with a JSON error envelope (contract: runTurn
  // throws only before the reply is hijacked).
  const refundBeforeStream = async (err: unknown): Promise<never> => {
    try {
      await refund({ originalIdempotencyKey: ledgerTurnKey, type: refundType });
    } catch (refundErr) {
      onError(refundErr, 'manna refund (pre-stream)');
    }
    throw err;
  };

  // Everything between the debit and the first SSE frame runs inside this
  // guarded block: a throw here refunds the debit before propagating, so no
  // path after a successful debit can orphan manna.
  const prepared = await (async (): Promise<{
    sink: TurnSink;
    gatewayMessage: string;
    prime: boolean;
    userMessage: { id: string; createdAt: Date };
  }> => {
    try {
      // 2. Primer (before inserting the new user message, so it is not included).
      const prime = needsPriming(session);
      let gatewayMessage = content;
      if (prime) {
        const primerMessages = await loadPrimerMessages(session.id);
        gatewayMessage = `${renderPrimer(primerMessages, user.username, user.accountId)}\n\n${content}`;
      }

      // 3. Persist the user message VERBATIM (the primer exists only gateway-
      //    side; history-sync backfills the gateway id via the PRIMER_HEADER
      //    suffix rule).
      const userMessage = await persistMessage({
        sessionId: session.id,
        senderId: user.accountId,
        role: 'user',
        content,
      });

      // 4. Media/trailing-sync correlation window.
      deps.registry.register(sessionKey, {
        sessionId: session.id,
        agentAccountId: agent.accountId,
        agentOpenclawId: agent.openclawId,
      });

      // 5. From here on the response is a live SSE stream.
      const sink = params.beginStream();
      return { sink, gatewayMessage, prime, userMessage };
    } catch (err) {
      return refundBeforeStream(err);
    }
  })();
  const { sink, gatewayMessage, prime, userMessage } = prepared;
  const outcome: TurnOutcome = {
    turnId,
    userMessageId: userMessage.id,
    assistantMessageId: null,
    errorCode: null,
    errorMessage: null,
    emptyTurn: false,
  };

  const publish = (event: SessionEvent): void => {
    try {
      deps.bus.publish(session.id, event);
    } catch (err) {
      onError(err, 'events-bus publish');
    }
    try {
      sink.emit(event);
    } catch (err) {
      onError(err, 'sse sink emit'); // client went away — keep the turn going
    }
  };

  const refundTurn = async (): Promise<boolean> => {
    let complete = true;
    for (const [key, type] of [
      [ledgerSettlementKey, `${refundType}:settle`],
      [ledgerTurnKey, refundType],
    ] as const) {
      try {
        const refunded = await refund({ originalIdempotencyKey: key, type });
        if (refunded) {
          publish({
            type: 'manna.updated',
            accountId: user.accountId,
            balance: refunded.balance.total,
          });
        }
      } catch (err) {
        complete = false;
        onError(err, 'manna refund');
      }
    }
    return complete;
  };

  let usageEventRecorded = false;
  let chargeSettlement: ChatChargeSettlement | undefined;
  const recordUsageEvent = async (record: {
    status: 'completed' | 'missing_usage' | 'unmetered' | 'error';
    usage?: GatewayUsage;
    metering?: ChatTurnMetering;
    settlement?: ChatChargeSettlement;
    /** Actual ledger charge after any terminal refund. */
    chargedManna?: number;
    messageId?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    finishReason?: string | null;
    emptyTurn?: boolean;
    usageCapture?: ClaudeTranscriptUsageResult | null;
    usageSource?: 'compat-tail' | 'claude-transcript' | 'missing';
  }, options: { dbc?: DbHandle; strict?: boolean } = {}): Promise<void> => {
    if (usageEventRecorded) return;
    try {
      const metering = record.metering ?? meterChatUsage(record.usage, meteringModel);
      // Paired with the usage_events_turn_unique partial index: a retried or
      // crashed-and-replayed pipeline cannot double-record this turn.
      await (options.dbc ?? db).insert(usageEvents).values({
        eventType: usageEventType,
        status: record.status,
        userId: user.accountId,
        agentId: agent.accountId,
        sessionId: session.id,
        messageId: record.messageId ?? null,
        turnId,
        provider: metering.provider,
        model: metering.model,
        pricingBasis,
        tableVersion: metering.status === 'metered' ? metering.tableVersion : null,
        promptTokens: record.usage?.promptTokens ?? null,
        completionTokens: record.usage?.completionTokens ?? null,
        cachedTokens: record.usage?.cachedTokens ?? null,
        cacheWriteTokens: record.usage?.cacheWriteTokens ?? null,
        totalTokens: record.usage?.totalTokens ?? null,
        costUsd: costUsdToNumeric(metering.costUsd),
        // Usage is an actual-billing surface. Metering retains the notional
        // model cost in metadata; this column follows what settlement really
        // charged after cap failures/refunds.
        manna: record.chargedManna ?? record.settlement?.chargedManna ?? metering.manna,
        latencyMs: Date.now() - turnStartedAtMs,
        errorCode: record.errorCode ?? null,
        errorMessage: record.errorMessage ?? null,
        metadata: {
          metering,
          agentConfig: {
            model: meteringModel,
            agentRuntime,
            pricingBasis,
            thinkingLevel: agent.thinkingLevel ?? DEFAULT_AGENT_THINKING_LEVEL,
          },
          usageSource: record.usageSource ?? (record.usage ? 'compat-tail' : 'missing'),
          claudeTranscript:
            record.usageCapture === undefined || record.usageCapture === null
              ? null
              : {
                  claudeSessionId: record.usageCapture.claudeSessionId,
                  providerMessageIds: record.usageCapture.providerMessageIds,
                  models: record.usageCapture.models,
                },
          settlement: record.settlement ?? null,
          finishReason: record.finishReason ?? null,
          emptyTurn: record.emptyTurn ?? null,
          userMessageId: userMessage.id,
          source: params.source ?? null,
        },
      }).onConflictDoNothing();
      usageEventRecorded = true;
    } catch (err) {
      if (options.strict === true) throw err;
      usageEventRecorded = true;
      onError(err, 'usage event insert');
    }
  };

  try {
    publish({ type: 'turn.started', sessionId: session.id, turnId });
    publish({ type: 'manna.updated', accountId: user.accountId, balance: debited.balance.total });

    let primedMarked = !prime;
    let completed = false;
    let terminalEvent: 'completed' | 'error' | null = null;
    // Transcript capture must begin at the provider handoff, not at the
    // earlier debit/primer work. Otherwise a just-finished queued turn in the
    // same Claude session could fall inside this turn's metering window.
    const usageWindowStartedAtMs = Date.now();

    await params.beforeProvider?.();
    for await (const event of deps.compat.chatTurn({
      agentId: agent.openclawId,
      sessionKey,
      userMessage: gatewayMessage,
      // Eden's DB configuration is authoritative on every request. OpenClaw
      // persists `/model` session overrides; omitting this header could execute
      // one model/runtime while billing the DB-selected model.
      modelOverride: meteringModel,
    })) {
      switch (event.type) {
        case 'turn.started': {
          // The gateway accepted the turn — the primer (if any) is now part of
          // the server-side session history, so mark the session primed.
          if (!primedMarked) {
            primedMarked = true;
            try {
              await db
                .update(sessions)
                .set({ gatewayPrimedAt: new Date(), updatedAt: new Date() })
                .where(eq(sessions.id, session.id));
            } catch (err) {
              onError(err, 'mark gateway_primed_at');
            }
          }
          break;
        }
        case 'token': {
          if (terminalEvent !== null) {
            onError(
              new Error(`gateway emitted token after terminal ${terminalEvent} event for turn ${turnId}`),
              'post-terminal gateway token',
            );
            break;
          }
          publish({ type: 'token', turnId, delta: event.delta });
          break;
        }
        case 'turn.completed': {
          if (terminalEvent !== null) {
            onError(
              new Error(`gateway emitted turn.completed after terminal ${terminalEvent} event for turn ${turnId}`),
              terminalEvent === 'completed'
                ? 'duplicate gateway completion'
                : 'post-error gateway completion',
            );
            break;
          }
          terminalEvent = 'completed';
          await params.beforeTerminal?.();
          completed = true;
          outcome.emptyTurn = event.emptyTurn;
          let effectiveUsage = event.usage;
          let usageCapture: ClaudeTranscriptUsageResult | undefined;
          let usageSource: 'compat-tail' | 'claude-transcript' | 'missing' = event.usage
            ? 'compat-tail'
            : 'missing';
          if (agentRuntime === 'claude-cli') {
            try {
              const capture =
                deps.claudeUsageCapture ??
                new ClaudeTranscriptUsageCapture({ dataDir: defaultOpenclawDataDir() });
              usageCapture = await capture.capture({
                agentId: agent.openclawId,
                sessionKey,
                startedAtMs: usageWindowStartedAtMs,
              });
              if (usageCapture) {
                // Transcript usage is authoritative when present: the compat
                // tail intentionally omits cache-write tokens in OpenClaw 7.1.
                effectiveUsage = usageCapture.usage;
                usageSource = 'claude-transcript';
              }
            } catch (err) {
              // Tail usage remains a proven primary fallback. Missing both is
              // recorded loudly as missing_usage; it is never a zero-cost row.
              onError(err, 'claude transcript usage capture');
            }
          }
          // OpenClaw 7.1 can translate a CLI spawn/auth failure into a
          // superficially successful compat tail whose text is
          // "Error: internal error" and whose usage fields are all zero. A
          // real Claude CLI completion always has either an attributable
          // transcript provider message or positive compat-tail usage. Fail
          // closed here so an absent/expired subscription login is visible,
          // fully refunded, and never mistaken for a provider-API success.
          if (
            agentRuntime === 'claude-cli' &&
            usageCapture === undefined &&
            !hasPositiveUsage(effectiveUsage)
          ) {
            const errorCode = 'subscription_runtime_unavailable';
            const errorMessage =
              'Claude subscription runtime failed before returning billable usage';
            outcome.errorCode = errorCode;
            outcome.errorMessage = errorMessage;
            const fullyRefunded = await refundTurn();
            await params.beforeTerminal?.();
            await withClaimFence((dbc) =>
              recordUsageEvent(
                {
                  status: 'error',
                  usage: effectiveUsage,
                  chargedManna: fullyRefunded ? 0 : PRICING.chatTurn,
                  errorCode,
                  errorMessage,
                  finishReason: event.finishReason ?? null,
                  emptyTurn: event.emptyTurn,
                  usageCapture: null,
                  usageSource: 'missing',
                },
                dbc ? { dbc, strict: true } : {},
              ),
            );
            publish({ type: 'error', turnId, code: errorCode, message: errorMessage });
            break;
          }
          const metering = meterChatUsage(effectiveUsage, meteringModel);
          const settleChatCharge = async (): Promise<ChatChargeSettlement> => {
            if (metering.status !== 'metered') {
              return {
                status: 'unmetered',
                reservedManna: PRICING.chatTurn,
                chargedManna: PRICING.chatTurn,
                reason: metering.status,
              };
            }

            const meteredManna = metering.manna;
            const adjustmentManna = meteredManna - PRICING.chatTurn;
            if (adjustmentManna === 0) {
              return {
                status: 'settled',
                reservedManna: PRICING.chatTurn,
                meteredManna,
                adjustmentManna,
                chargedManna: meteredManna,
                balance: debited.balance.total,
                transactionId: null,
                alreadyApplied: false,
              };
            }

            try {
              if (adjustmentManna > 0) {
                const adjusted = await withClaimFence((dbc) =>
                  debit({
                    accountId: user.accountId,
                    amount: adjustmentManna,
                    type: isMemoryDream ? 'spend:memory-dream:settle' : 'spend:chat:settle',
                    idempotencyKey: ledgerSettlementKey,
                    dailyCap,
                    ...(isAutomation
                      ? { rollingCap: automationRollingCap(agent.accountId) }
                      : {}),
                    ...(taskExternalId ? { taskExternalId } : {}),
                    ...(dbc ? { db: dbc } : {}),
                  }),
                );
                publish({
                  type: 'manna.updated',
                  accountId: user.accountId,
                  balance: adjusted.balance.total,
                });
                return {
                  status: 'settled',
                  reservedManna: PRICING.chatTurn,
                  meteredManna,
                  adjustmentManna,
                  chargedManna: meteredManna,
                  balance: adjusted.balance.total,
                  transactionId: adjusted.transaction.id,
                  alreadyApplied: adjusted.alreadyApplied,
                };
              }

              // Manna prices are integer-ceiled, so reserve=1 can only adjust
              // downward to zero. Use the linked, idempotent full refund: a
              // free turn must release both daily and rolling headroom at the
              // original debit timestamp.
              const adjusted = await withClaimFence((dbc) =>
                refund({
                  originalIdempotencyKey: ledgerTurnKey,
                  type: isMemoryDream ? 'refund:memory-dream:settle' : 'refund:chat:settle',
                  ...(dbc ? { db: dbc } : {}),
                }),
              );
              if (!adjusted) throw new Error('chat reserve disappeared before settlement refund');
              publish({
                type: 'manna.updated',
                accountId: user.accountId,
                balance: adjusted.balance.total,
              });
              return {
                status: 'settled',
                reservedManna: PRICING.chatTurn,
                meteredManna,
                adjustmentManna,
                chargedManna: meteredManna,
                balance: adjusted.balance.total,
                transactionId: adjusted.transaction.id,
                alreadyApplied: adjusted.alreadyApplied,
              };
            } catch (err) {
              if (err instanceof TurnClaimLostError) throw err;
              onError(err, 'chat charge settlement');
              return {
                status: 'failed',
                reservedManna: PRICING.chatTurn,
                meteredManna,
                adjustmentManna,
                chargedManna: PRICING.chatTurn,
                errorCode: settlementErrorCode(err),
                error: err instanceof Error ? err.message : String(err),
              };
            }
          };
          const meteringWithAccounts = {
            ...metering,
            userAccountId: user.accountId,
            agentAccountId: agent.accountId,
          };
          const messageData = {
            kind: 'chat_turn',
            turnId,
            usage: effectiveUsage ?? null,
            metering: meteringWithAccounts,
            agentConfig: {
              model: meteringModel,
              agentRuntime,
              pricingBasis,
              thinkingLevel: agent.thinkingLevel ?? DEFAULT_AGENT_THINKING_LEVEL,
            },
            usageSource,
            claudeTranscript: usageCapture
              ? {
                  claudeSessionId: usageCapture.claudeSessionId,
                  providerMessageIds: usageCapture.providerMessageIds,
                  models: usageCapture.models,
                }
              : null,
            settlement: null as ChatChargeSettlement | null,
            emptyTurn: event.emptyTurn,
            finishReason: event.finishReason ?? null,
            source: params.source ?? null,
          };
          // Usage capture can involve filesystem I/O. Re-fence after it so a
          // process suspended during capture cannot finalize on a generation
          // that recovery has since superseded.
          await params.beforeTerminal?.();
          const settlement = await settleChatCharge();
          chargeSettlement = settlement;
          if (settlement.status === 'failed') {
            // The provider completed, but exact settlement could not fit the
            // account/automation caps (or the remaining balance). Fail closed:
            // expose no zero/under-billed success and refund every debit that
            // landed for this turn. The ledger cap itself was never crossed.
            const fullyRefunded = await refundTurn();
            await params.beforeTerminal?.();
            const failedSettlement = {
              ...settlement,
              chargedManna: fullyRefunded ? 0 : settlement.chargedManna,
            };
            chargeSettlement = failedSettlement;
            outcome.errorCode = settlement.errorCode;
            outcome.errorMessage = settlement.error;
            await withClaimFence((dbc) =>
              recordUsageEvent(
                {
                  status: 'error',
                  usage: effectiveUsage,
                  metering,
                  settlement: failedSettlement,
                  errorCode: settlement.errorCode,
                  errorMessage: settlement.error,
                  finishReason: event.finishReason ?? null,
                  emptyTurn: event.emptyTurn,
                  usageCapture: usageCapture ?? null,
                  usageSource,
                },
                dbc ? { dbc, strict: true } : {},
              ),
            );
            publish({
              type: 'error',
              turnId,
              code: settlement.errorCode,
              message: settlement.error,
            });
            break;
          }
          await params.beforeTerminal?.();
          await params.beforeTerminalPersistence?.();
          // For durable callers, the final generation renewal, assistant row,
          // and terminal usage checkpoint share one transaction. Even a
          // process suspended for the full lease immediately before this write
          // cannot resume after recovery and persist a zombie completion.
          const assistant = await withClaimFence(async (dbc) => {
            const inserted = await persistMessage(
              {
                sessionId: session.id,
                senderId: agent.accountId,
                role: 'assistant',
                content: event.text,
                name: agent.username,
                edenMessageData: { ...messageData, settlement },
              },
              dbc,
            );
            await recordUsageEvent(
              {
                status:
                  metering.status === 'metered'
                    ? 'completed'
                    : metering.status === 'missing_usage'
                      ? 'missing_usage'
                      : 'unmetered',
                usage: effectiveUsage,
                metering,
                settlement,
                messageId: inserted.id,
                finishReason: event.finishReason ?? null,
                emptyTurn: event.emptyTurn,
                usageCapture: usageCapture ?? null,
                usageSource,
              },
              dbc ? { dbc, strict: true } : {},
            );
            return inserted;
          });
          outcome.assistantMessageId = assistant.id;
          if (event.emptyTurn) {
            // Agent said nothing — typically an async media tool is running
            // (spike: compat filler suppressed upstream). Signal the UI.
            publish({ type: 'media.pending', sessionId: session.id, tool: 'unknown' });
          }
          const sharedUsage = toSharedUsage(effectiveUsage);
          publish({
            type: 'turn.completed',
            turnId,
            messageId: assistant.id,
            ...(sharedUsage ? { usage: sharedUsage } : {}),
          });
          break;
        }
        case 'error': {
          if (terminalEvent !== null) {
            onError(
              new Error(`gateway emitted error after terminal ${terminalEvent} event for turn ${turnId}`),
              'post-terminal gateway error',
            );
            break;
          }
          terminalEvent = 'error';
          await params.beforeTerminal?.();
          outcome.errorCode = event.code;
          outcome.errorMessage = event.message;
          const fullyRefunded = await refundTurn();
          await params.beforeTerminal?.();
          await withClaimFence((dbc) =>
            recordUsageEvent(
              {
                status: 'error',
                chargedManna: fullyRefunded ? 0 : PRICING.chatTurn,
                errorCode: event.code,
                errorMessage: event.message,
              },
              dbc ? { dbc, strict: true } : {},
            ),
          );
          publish({ type: 'error', turnId, code: event.code, message: event.message });
          break;
        }
      }
    }

    if (!completed && outcome.errorCode === null) {
      // Stream ended without a terminal event (should not happen) — refund.
      await params.beforeTerminal?.();
      outcome.errorCode = 'gateway_stream_error';
      outcome.errorMessage = 'gateway stream ended without completing the turn';
      const fullyRefunded = await refundTurn();
      await params.beforeTerminal?.();
      await withClaimFence((dbc) =>
        recordUsageEvent(
          {
            status: 'error',
            chargedManna: fullyRefunded ? 0 : PRICING.chatTurn,
            errorCode: 'gateway_stream_error',
            errorMessage: 'gateway stream ended without completing the turn',
          },
          dbc ? { dbc, strict: true } : {},
        ),
      );
      publish({
        type: 'error',
        turnId,
        code: 'gateway_stream_error',
        message: 'gateway stream ended without completing the turn',
      });
    }
  } catch (caught) {
    let err = caught;
    // An internal failure may itself occur after provider handoff but before
    // terminal persistence. Re-check the caller generation before writing an
    // error usage row; a stale claimant must not finalize anything after its
    // recovery owner has taken over.
    if (!(err instanceof TurnClaimLostError) && params.beforeTerminal) {
      try {
        await params.beforeTerminal();
      } catch (fenceError) {
        err = fenceError;
      }
    }
    if (err instanceof TurnClaimLostError) {
      outcome.errorCode = err.code;
      outcome.errorMessage = err.message;
      onError(err, 'durable turn claim lost');
      // The recovery owner may already have reversed either key. Both calls
      // are idempotent; deliberately do not persist a late usage/error row.
      await refundTurn();
      publish({ type: 'error', turnId, code: err.code, message: err.message });
    } else {
      outcome.errorCode = 'internal_error';
      outcome.errorMessage = err instanceof Error ? err.message : 'turn pipeline failed';
      onError(err, 'turn pipeline');
      const fullyRefunded = await refundTurn();
      if (chargeSettlement) {
        chargeSettlement = {
          ...chargeSettlement,
          chargedManna: fullyRefunded ? 0 : chargeSettlement.chargedManna,
        };
      }
      await withClaimFence((dbc) =>
        recordUsageEvent(
          {
            status: 'error',
            settlement: chargeSettlement,
            chargedManna:
              chargeSettlement?.chargedManna ?? (fullyRefunded ? 0 : PRICING.chatTurn),
            errorCode: 'internal_error',
            errorMessage: err instanceof Error ? err.message : 'turn pipeline failed',
          },
          dbc ? { dbc, strict: true } : {},
        ),
      );
      publish({
        type: 'error',
        turnId,
        code: 'internal_error',
        message: err instanceof Error ? err.message : 'turn pipeline failed',
      });
    }
  } finally {
    try {
      sink.end();
    } catch (err) {
      onError(err, 'sse sink end');
    }
  }

  // 8. Trailing sync — async media completions & anything else that posts
  //    into the gateway session after the HTTP turn ended.
  if (outcome.errorCode === null) {
    deps.registry.touch(sessionKey);
    deps.historySync.scheduleTrailingSync({
      session,
      agentOpenclawId: agent.openclawId,
      agentAccountId: agent.accountId,
    });
  }

  return outcome;
}
