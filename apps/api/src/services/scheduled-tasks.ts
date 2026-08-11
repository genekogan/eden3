import { createHash, randomUUID } from 'node:crypto';

import {
  RollingSpendCapExceededError,
  gatewaySessionKey,
  refund,
  resolveSession,
  type AuthSession,
  type DbHandle,
} from '@eden3/core';
import {
  accounts,
  agents,
  db,
  mannaTransactions,
  sessionAgents,
  sessionUsers,
  sessions,
  triggers,
  turnAuthorizations,
  usageEvents,
  type Session,
  type Trigger,
} from '@eden3/db';
import { getModelAgentRuntime } from '@eden3/gateway';
import { DEFAULT_AGENT_MODEL, DEFAULT_AGENT_THINKING_LEVEL } from '@eden3/shared';
import { and, eq, inArray, isNull, like, or, sql } from 'drizzle-orm';

import { ApiError } from '../errors';
import { defaultOpenclawDataDir } from '../gateway-glue';
import type { EventsBus } from '../events-bus';
import { publishAppNotification } from './app-notifications';
import {
  AUTOMATION_BUDGET_SCOPE,
  AUTOMATION_HOURLY_BUDGET_ERROR,
  automationLedgerKey,
  assertAutomationBudget,
} from './automation-budget';
import type { HistorySync } from './history-sync';
import type { TurnRegistry } from './turn-registry';
import {
  reverseTurnAuthorization,
  settlePartialOutputAuthorization,
} from './turn-authorization';
import {
  runTurn,
  TurnClaimLostError,
  type CompatClientLike,
  type TurnAgent,
  type TurnOutcome,
  type TurnSink,
} from './turns';

export type ScheduledRefund = typeof refund;

export interface ScheduledRunDeps {
  /** Provider dependencies are absent for compensation-only recovery. */
  compat?: CompatClientLike;
  bus?: EventsBus;
  registry?: TurnRegistry;
  historySync?: HistorySync;
  refundLedger?: ScheduledRefund;
  onError?: (err: unknown, context: string) => void;
  /** TEST SEAM: pause immediately before the durable debit-lease renewal. */
  beforeLeaseRenewal?: (claim: {
    triggerId: string;
    occurrenceId: string;
    claimId: string;
  }) => Promise<void>;
  /** TEST SEAM: pause after terminal preflight but before atomic persistence. */
  beforeTerminalPersistence?: () => Promise<void>;
  /** TEST SEAMS: production always uses the canonical authorization machine. */
  reverseAuthorization?: typeof reverseTurnAuthorization;
  settlePartialOutput?: typeof settlePartialOutputAuthorization;
}

export interface ScheduledRunResult {
  triggerId: string;
  sessionId: string;
  outcome: TurnOutcome;
  lastRunTime: string;
}

export interface ScheduledTaskOccurrence {
  /** Stable task-scoped UUID derived from its scheduled or caller-supplied request identity. */
  id: string;
  kind: 'manual' | 'scheduled';
  dueAt: Date | null;
}

function uuidFromDigest(input: string): string {
  const bytes = createHash('sha256').update(input).digest().subarray(0, 16);
  // RFC 4122 variant + v5-shaped deterministic UUID (SHA-256 payload).
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** One deterministic execution identity for one scheduled due instant. */
export function scheduledTaskOccurrence(
  triggerId: string,
  dueAt: Date,
): ScheduledTaskOccurrence {
  return {
    id: uuidFromDigest(`eden3:scheduled-task-occurrence:v1\0${triggerId}\0${dueAt.toISOString()}`),
    kind: 'scheduled',
    dueAt,
  };
}

export function manualTaskOccurrence(
  triggerId: string,
  requestId: string = randomUUID(),
): ScheduledTaskOccurrence {
  return {
    id: uuidFromDigest(`eden3:scheduled-task-manual:v1\0${triggerId}\0${requestId}`),
    kind: 'manual',
    dueAt: null,
  };
}

/** Scheduler-visible error whose trigger streak was already stamped by the runner. */
export class RecordedScheduledTaskError extends ApiError {
  readonly triggerErrorRecorded = true;
}

function titleFromTrigger(trigger: Trigger): string {
  const name = trigger.name?.trim();
  return name ? `[Task] ${name}` : '[Task] Scheduled run';
}

function emptySink(): TurnSink {
  return { emit() {}, end() {} };
}

async function loadTaskOwner(trigger: Trigger): Promise<AuthSession> {
  if (!trigger.userId) {
    throw new ApiError(409, 'task_missing_owner', `Task ${trigger.id} has no owner`);
  }
  const [owner] = await db
    .select({
      id: accounts.id,
      username: accounts.username,
      type: accounts.type,
      deleted: accounts.deleted,
    })
    .from(accounts)
    .where(eq(accounts.id, trigger.userId))
    .limit(1);
  if (!owner || owner.deleted || owner.type !== 'user') {
    throw new ApiError(409, 'task_owner_unavailable', `Task ${trigger.id} owner is unavailable`);
  }
  return { accountId: owner.id, username: owner.username, isAdmin: false };
}

async function loadTaskAgent(trigger: Trigger): Promise<TurnAgent> {
  if (!trigger.agentId) {
    throw new ApiError(409, 'task_missing_agent', `Task ${trigger.id} has no agent`);
  }
  const [row] = await db
    .select({
      accountId: accounts.id,
      username: accounts.username,
      deleted: accounts.deleted,
      ownerId: agents.ownerId,
      openclawId: agents.openclawId,
      model: agents.model,
      thinkingLevel: agents.thinkingLevel,
      provisionStatus: agents.provisionStatus,
    })
    .from(agents)
    .innerJoin(accounts, eq(accounts.id, agents.accountId))
    .where(eq(agents.accountId, trigger.agentId))
    .limit(1);
  if (!row) {
    throw new ApiError(409, 'task_agent_unavailable', `Task ${trigger.id} agent is unavailable`);
  }
  if (row.deleted) {
    throw new ApiError(409, 'task_agent_unavailable', `Task ${trigger.id} agent is unavailable`);
  }
  if (!trigger.userId || row.ownerId !== trigger.userId) {
    throw new ApiError(
      409,
      'task_agent_owner_mismatch',
      `Task ${trigger.id} agent is not owned by its task owner`,
    );
  }
  if (!row.openclawId || row.provisionStatus !== 'ready') {
    throw new ApiError(409, 'task_agent_not_ready', `Task ${trigger.id} agent is not ready`);
  }
  const model = row.model ?? DEFAULT_AGENT_MODEL;
  return {
    accountId: row.accountId,
    username: row.username,
    ownerId: row.ownerId,
    openclawId: row.openclawId,
    model,
    agentRuntime: await getModelAgentRuntime(model, { dataDir: defaultOpenclawDataDir() }),
    thinkingLevel: row.thinkingLevel ?? DEFAULT_AGENT_THINKING_LEVEL,
  };
}

async function createRunSession(
  trigger: Trigger,
  owner: AuthSession,
  agent: TurnAgent,
  sessionId: string,
): Promise<Session> {
  const [session] = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(sessions)
      .values({
        id: sessionId,
        ownerId: owner.accountId,
        title: titleFromTrigger(trigger),
        sessionType: 'scheduled_task',
        gatewaySessionKey: gatewaySessionKey(sessionId),
      })
      .onConflictDoNothing()
      .returning();
    const existing = row ?? (
      await tx
        .select()
        .from(sessions)
        .where(and(eq(sessions.id, sessionId), eq(sessions.ownerId, owner.accountId)))
        .limit(1)
    )[0];
    if (!existing || existing.sessionType !== 'scheduled_task') {
      throw new Error('scheduled task occurrence session identity conflict');
    }
    await tx
      .insert(sessionAgents)
      .values({ sessionId, agentAccountId: agent.accountId })
      .onConflictDoNothing();
    await tx
      .insert(sessionUsers)
      .values({ sessionId, userAccountId: owner.accountId })
      .onConflictDoNothing();
    return [existing] as const;
  });
  return session;
}

async function resolveRunSession(
  trigger: Trigger,
  owner: AuthSession,
  agent: TurnAgent,
  occurrence: ScheduledTaskOccurrence,
): Promise<Session> {
  if (trigger.sessionTarget === 'existing') {
    if (!trigger.sessionExternalId) {
      throw new ApiError(
        409,
        'task_session_unavailable',
        `Task ${trigger.id} has no selected output session`,
      );
    }
    const existing = await resolveSession(trigger.sessionExternalId);
    const [membership] = existing
      ? await db
          .select({ agentAccountId: sessionAgents.agentAccountId })
          .from(sessionAgents)
          .where(
            and(
              eq(sessionAgents.sessionId, existing.id),
              eq(sessionAgents.agentAccountId, agent.accountId),
            ),
          )
          .limit(1)
      : [];
    if (
      !existing ||
      existing.ownerId !== owner.accountId ||
      existing.deleted ||
      existing.visible === false ||
      existing.channelConnectionId !== null ||
      existing.sessionType === 'channel' ||
      !membership
    ) {
      throw new ApiError(
        409,
        'task_session_unavailable',
        'The selected output session is unavailable for this agent',
      );
    }
    if (existing.gatewaySessionKey) return existing;
    const [updated] = await db
      .update(sessions)
      .set({ gatewaySessionKey: gatewaySessionKey(existing.id), updatedAt: new Date() })
      .where(
        and(
          eq(sessions.id, existing.id),
          eq(sessions.ownerId, owner.accountId),
          eq(sessions.deleted, false),
        ),
      )
      .returning();
    if (updated) return updated;
    throw new ApiError(
      409,
      'task_session_unavailable',
      'The selected output session changed before the run started',
    );
  }
  if (trigger.sessionTarget !== 'new') {
    throw new ApiError(
      409,
      'task_session_unavailable',
      `Task ${trigger.id} has an invalid output-session policy`,
    );
  }
  return await createRunSession(trigger, owner, agent, occurrence.id);
}

export const SCHEDULED_TASK_EMPTY_RESPONSE = 'scheduled_task_empty_response';
export const SCHEDULED_TASK_INDETERMINATE = 'scheduled_task_occurrence_indeterminate';
export const SCHEDULED_TASK_REFUND_PENDING = 'scheduled_task_occurrence_refund_pending';
export const SCHEDULED_TASK_REFUND_PENDING_PREFIX = 'Scheduled occurrence refund pending:';
export const SCHEDULED_TASK_STALE_RECOVERY_PREFIX =
  'Scheduled occurrence stale recovery pending:';

function hasRecoveryMarker(message: string | null): boolean {
  return (
    message?.startsWith(SCHEDULED_TASK_REFUND_PENDING_PREFIX) === true ||
    message?.startsWith(SCHEDULED_TASK_STALE_RECOVERY_PREFIX) === true
  );
}

/** A durable occurrence that may run compensation/checkpoint recovery only. */
export function isScheduledTaskRecoveryPending(
  trigger: Pick<Trigger, 'pendingOccurrenceId' | 'lastError'>,
): boolean {
  return trigger.pendingOccurrenceId !== null && hasRecoveryMarker(trigger.lastError);
}

function claimLost(triggerId: string): TurnClaimLostError {
  return new TurnClaimLostError(
    `Task ${triggerId} occurrence claim was superseded before funding or settlement`,
  );
}

/**
 * Refresh the exact claim generation immediately before its first debit.
 *
 * The stale reaper clears `pending_occurrence_claim_id`. PostgreSQL row-update
 * serialization therefore gives two safe orders: renewal first makes the
 * lease fresh, while reaping first makes this update return no row. A later
 * recovery claimant uses a new UUID, so an old process cannot become valid
 * again merely because the same occurrence is `running` once more.
 */
export async function renewScheduledTaskOccurrenceLease(params: {
  triggerId: string;
  occurrenceId: string;
  claimId: string;
}, dbc: DbHandle = db): Promise<void> {
  const renewed = await dbc
    .update(triggers)
    .set({ updatedAt: new Date() })
    .where(
      and(
        eq(triggers.id, params.triggerId),
        inArray(triggers.status, ['running', 'paused']),
        eq(triggers.deleted, false),
        eq(triggers.pendingOccurrenceId, params.occurrenceId),
        eq(triggers.pendingOccurrenceClaimId, params.claimId),
      ),
    )
    .returning({ id: triggers.id });
  if (renewed.length === 0) throw claimLost(params.triggerId);
}

/**
 * Revalidate tenant, agent, and output-session authority inside every money
 * transaction that can hand out or terminalize a provider ticket.
 */
async function fenceScheduledTaskExecution(
  params: {
    triggerId: string;
    occurrenceId: string;
    claimId: string;
    sessionId: string;
  },
  dbc: DbHandle,
): Promise<void> {
  await renewScheduledTaskOccurrenceLease(params, dbc);
  const rows = (await dbc.execute(sql`
    select t.id
    from triggers t
    join accounts u on u.id = t.user_id
    join agents g on g.account_id = t.agent_id
    join accounts a on a.id = g.account_id
    join sessions s on s.id = ${params.sessionId}::uuid
    join session_agents sa
      on sa.session_id = s.id and sa.agent_account_id = g.account_id
    where t.id = ${params.triggerId}::uuid
      and t.deleted = false
      and t.status in ('running', 'paused')
      and t.pending_occurrence_id = ${params.occurrenceId}::uuid
      and t.pending_occurrence_claim_id = ${params.claimId}::uuid
      and u.type = 'user' and u.deleted = false
      and a.type = 'agent' and a.deleted = false
      and g.owner_id = u.id
      and g.openclaw_id is not null
      and g.provision_status = 'ready'
      and s.owner_id = u.id
      and s.deleted = false
      and s.visible is distinct from false
      and s.channel_connection_id is null
      and s.session_type is distinct from 'channel'
    for key share of u, a, g, s, sa
  `)) as unknown as { id: string }[];
  if (rows.length !== 1) {
    throw new TurnClaimLostError(
      `Task ${params.triggerId} execution authority changed before provider work`,
    );
  }
}

function occurrenceCheckpoint(occurrence: ScheduledTaskOccurrence): Date {
  return occurrence.dueAt ?? new Date();
}

function sameInstant(a: Date | null, b: Date | null): boolean {
  return a !== null && b !== null && a.getTime() === b.getTime();
}

async function markTaskOutcome(
  deps: ScheduledRunDeps,
  trigger: Trigger,
  occurrence: ScheduledTaskOccurrence,
  claimId: string,
  outcome: TurnOutcome,
  sessionId: string | null,
  checkpointOverride?: Date,
): Promise<Date> {
  const checkpoint = checkpointOverride ?? occurrenceCheckpoint(occurrence);
  const failed = outcome.errorCode !== null;
  const notificationId = await db.transaction(async (tx) => {
    const updated = await tx
      .update(triggers)
      .set({
        // Pausing is the one safe owner mutation while an occurrence is in
        // flight. Preserve a pause observed after the original claim, and also
        // restore it when the scheduler temporarily claims a paused recovery.
        status: sql`case
          when ${triggers.status} = 'paused' or ${trigger.status === 'paused'} then 'paused'
          else 'active'
        end`,
        lastRunTime: checkpoint,
        lastError: failed
          ? (outcome.errorMessage ?? outcome.errorCode ?? 'scheduled task failed').slice(0, 2000)
          : null,
        // A restart can replay the trigger row before next_scheduled_run is
        // stamped. The due instant is the occurrence checkpoint, so recovering
        // the same failure never increments its streak twice.
        errorCount: failed
          ? sql`case when ${triggers.lastRunTime} is distinct from ${checkpoint.toISOString()}::timestamptz
              then coalesce(${triggers.errorCount}, 0) + 1
              else coalesce(${triggers.errorCount}, 0) end`
          : 0,
        updatedAt: new Date(),
        pendingOccurrenceId: null,
        pendingOccurrenceKind: null,
        pendingOccurrenceAt: null,
        pendingOccurrenceClaimId: null,
      })
      .where(
        and(
          eq(triggers.id, trigger.id),
          inArray(triggers.status, ['running', 'paused']),
          eq(triggers.deleted, false),
          eq(triggers.pendingOccurrenceId, occurrence.id),
          eq(triggers.pendingOccurrenceClaimId, claimId),
        ),
      )
      .returning({ id: triggers.id });
    if (updated.length === 0) throw claimLost(trigger.id);

    if (failed || !sessionId || !trigger.userId || !trigger.agentId) return null;
    const inserted = (await tx.execute(sql`
      insert into app_notifications (
        id, account_id, kind, source_agent_id, target_path
      )
      values (
        ${occurrence.id}::uuid, ${trigger.userId}::uuid,
        'scheduled_task_completed', ${trigger.agentId}::uuid,
        ${`/sessions/${sessionId}`}
      )
      on conflict (id) do nothing
      returning id
    `)) as unknown as { id: string }[];
    return inserted[0]?.id ?? null;
  });
  if (notificationId && deps.bus && trigger.userId) {
    try {
      await publishAppNotification(
        deps.bus,
        trigger.userId,
        'scheduled_task_completed',
        notificationId,
      );
    } catch (err) {
      deps.onError?.(err, 'scheduled task completion notification publish');
    }
  }
  return checkpoint;
}

async function markTaskError(
  deps: ScheduledRunDeps,
  trigger: Trigger,
  occurrence: ScheduledTaskOccurrence,
  claimId: string,
  err: unknown,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await markTaskOutcome(deps, trigger, occurrence, claimId, {
    turnId: occurrence.id,
    userMessageId: occurrence.id,
    assistantMessageId: null,
    errorCode: err instanceof ApiError ? err.code : 'scheduled_task_error',
    errorMessage: message,
  }, null);
}

async function releaseTaskForRefundRetry(
  trigger: Trigger,
  occurrence: ScheduledTaskOccurrence,
  claimId: string,
  message: string,
): Promise<void> {
  const released = await db
    .update(triggers)
    .set({
      status: sql`case
        when ${triggers.status} = 'paused' or ${trigger.status === 'paused'} then 'paused'
        else 'active'
      end`,
      lastError: message.slice(0, 2000),
      updatedAt: new Date(),
      pendingOccurrenceClaimId: null,
    })
    .where(
      and(
        eq(triggers.id, trigger.id),
        inArray(triggers.status, ['running', 'paused']),
        eq(triggers.deleted, false),
        eq(triggers.pendingOccurrenceId, occurrence.id),
        eq(triggers.pendingOccurrenceClaimId, claimId),
      ),
    )
    .returning({ id: triggers.id });
  if (released.length === 0) throw claimLost(trigger.id);
}

/**
 * A scheduled failure is terminal only after both possible charge legs are
 * reversed. Calling both refunds is safe even when a leg never landed, and is
 * deliberately repeated on recovery until both calls complete successfully.
 */
async function refundScheduledFailure(
  deps: ScheduledRunDeps,
  trigger: Trigger,
  occurrence: ScheduledTaskOccurrence,
  claimId: string,
): Promise<void> {
  if (!trigger.agentId) return;
  const fence = (dbc: DbHandle) =>
    renewScheduledTaskOccurrenceLease(
      { triggerId: trigger.id, occurrenceId: occurrence.id, claimId },
      dbc,
    );
  const settlePartial = deps.settlePartialOutput ?? settlePartialOutputAuthorization;
  const reverseAuthorization = deps.reverseAuthorization ?? reverseTurnAuthorization;

  try {
    const partial = await settlePartial({
      turnId: occurrence.id,
      errorCode: SCHEDULED_TASK_INDETERMINATE,
      errorMessage:
        'Scheduled task process ended after emitting usable output; full authorized reserve retained',
      fence,
    });
    if (partial.eligible) return;

    const reversed = await reverseAuthorization({
      turnId: occurrence.id,
      refundType: 'refund:chat:scheduled-failure',
      fence,
    });
    if (reversed.partialOutputRequired) {
      const raced = await settlePartial({
        turnId: occurrence.id,
        errorCode: SCHEDULED_TASK_INDETERMINATE,
        errorMessage:
          'Scheduled task process ended after emitting usable output; full authorized reserve retained',
        fence,
      });
      if (!raced.eligible) {
        throw new Error('scheduled task usable-output authorization could not be terminalized');
      }
      return;
    }

    // A terminal v2 authorization owns the exact subscription/durable split.
    // Never follow it with the legacy durable-only refund path.
    const [authorization] = await db
      .select({ state: turnAuthorizations.state })
      .from(turnAuthorizations)
      .where(eq(turnAuthorizations.turnId, occurrence.id))
      .limit(1);
    if (authorization) {
      if (authorization.state === 'reserved') {
        throw new Error('scheduled task authorization remained reserved after recovery');
      }
      return;
    }
  } catch (err) {
    if (err instanceof TurnClaimLostError) throw err;
    try {
      deps.onError?.(err, 'scheduled occurrence authorization recovery');
    } catch {
      // Error reporting must not hide the durable refund-pending marker.
    }
    const message =
      `${SCHEDULED_TASK_REFUND_PENDING_PREFIX} canonical authorization recovery failed; ` +
      'the occurrence remains due and will retry without provider execution';
    await releaseTaskForRefundRetry(trigger, occurrence, claimId, message);
    throw new ApiError(503, SCHEDULED_TASK_REFUND_PENDING, message);
  }

  // Pre-authorization compatibility only. Absence of a turn_authorizations
  // row is proven above before these legacy idempotent keys are considered.
  const refundLedger = deps.refundLedger ?? refund;
  const failedReversals: string[] = [];
  for (const reversal of [
    {
      label: 'settlement',
      originalIdempotencyKey: automationLedgerKey(trigger.agentId, occurrence.id, 'settle'),
      type: 'refund:chat:settle',
    },
    {
      label: 'reservation',
      originalIdempotencyKey: automationLedgerKey(trigger.agentId, occurrence.id),
      type: 'refund:chat',
    },
  ]) {
    try {
      await refundLedger({
        originalIdempotencyKey: reversal.originalIdempotencyKey,
        type: reversal.type,
      });
    } catch (err) {
      failedReversals.push(reversal.label);
      try {
        deps.onError?.(err, `scheduled occurrence ${reversal.label} recovery refund`);
      } catch {
        // Error reporting must not convert an outstanding refund into a
        // checkpointed failure.
      }
    }
  }
  if (failedReversals.length === 0) return;

  const message =
    `${SCHEDULED_TASK_REFUND_PENDING_PREFIX} ${failedReversals.join(' and ')} reversal failed; ` +
    'the occurrence remains due and will retry without provider execution';
  await releaseTaskForRefundRetry(trigger, occurrence, claimId, message);
  throw new ApiError(503, SCHEDULED_TASK_REFUND_PENDING, message);
}

async function recoveredUsageOutcome(occurrence: ScheduledTaskOccurrence): Promise<{
  sessionId: string;
  outcome: TurnOutcome;
  createdAt: Date;
} | null> {
  const [row] = await db
    .select({
      status: usageEvents.status,
      sessionId: usageEvents.sessionId,
      messageId: usageEvents.messageId,
      errorCode: usageEvents.errorCode,
      errorMessage: usageEvents.errorMessage,
      metadata: usageEvents.metadata,
      createdAt: usageEvents.createdAt,
    })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.eventType, 'chat_turn'),
        eq(usageEvents.turnId, occurrence.id),
        // Provider admission creates a content-free anchor before any
        // external call. It is not completion evidence: accepting that row
        // here can turn a quarantined in-flight occurrence into a false
        // success. Only the four terminal chat-turn states are replayable.
        inArray(usageEvents.status, ['completed', 'missing_usage', 'unmetered', 'error']),
      ),
    )
    .limit(1);
  if (!row) return null;
  const metadata =
    typeof row.metadata === 'object' && row.metadata !== null
      ? (row.metadata as { emptyTurn?: unknown; userMessageId?: unknown })
      : {};
  const emptyTurn = metadata.emptyTurn === true;
  const errorCode =
    row.errorCode ??
    (emptyTurn
      ? SCHEDULED_TASK_EMPTY_RESPONSE
      : row.status === 'error'
        ? 'scheduled_task_turn_failed'
        : null);
  return {
    sessionId: row.sessionId ?? occurrence.id,
    outcome: {
      turnId: occurrence.id,
      userMessageId:
        typeof metadata.userMessageId === 'string' ? metadata.userMessageId : occurrence.id,
      assistantMessageId: row.messageId,
      errorCode,
      errorMessage:
        row.errorMessage ??
        (emptyTurn ? 'Scheduled task completed without an assistant response' : errorCode),
      emptyTurn,
    },
    createdAt: row.createdAt,
  };
}

/**
 * Execute one scheduled prompt as a normal metered chat turn.
 *
 * The scheduler/cron layer decides when to call this. This function owns the
 * durable run effects: a session transcript, standard usage_events rows,
 * normal manna debit/settlement/refund behavior, and trigger last-run/error
 * stamps. Creating or syncing a trigger never calls this function, so idle
 * scheduled tasks do not spend manna.
 */
export async function runScheduledTask(
  deps: ScheduledRunDeps,
  trigger: Trigger,
  requestedOccurrence: ScheduledTaskOccurrence = manualTaskOccurrence(trigger.id),
): Promise<ScheduledRunResult> {
  if (trigger.deleted) throw new ApiError(404, 'task_not_found', `No task "${trigger.id}"`);
  const recoveryOnly = isScheduledTaskRecoveryPending(trigger);
  const pausedRecovery = trigger.status === 'paused' && recoveryOnly;
  if (trigger.status !== 'active' && !pausedRecovery) {
    throw new ApiError(409, 'task_not_active', `Task ${trigger.id} is not active`);
  }

  // Atomic active->running claim: two concurrent fire requests (user +
  // admin, or a retried scheduler tick) cannot both run the task. Claim before
  // creating the output session so the losing request cannot leave an orphan
  // transcript container behind.
  const claimId = randomUUID();
  const expectedOccurrenceId = trigger.pendingOccurrenceId ?? requestedOccurrence.id;
  const recoveryMarker = or(
    like(triggers.lastError, `${SCHEDULED_TASK_REFUND_PENDING_PREFIX}%`),
    like(triggers.lastError, `${SCHEDULED_TASK_STALE_RECOVERY_PREFIX}%`),
  );
  const claimed = await db
    .update(triggers)
    .set({
      status: 'running',
      lastError: null,
      updatedAt: new Date(),
      pendingOccurrenceClaimId: claimId,
      pendingOccurrenceId: sql`coalesce(${triggers.pendingOccurrenceId}, ${requestedOccurrence.id}::uuid)`,
      pendingOccurrenceKind: sql`coalesce(${triggers.pendingOccurrenceKind}, ${requestedOccurrence.kind})`,
      pendingOccurrenceAt: sql`case
        when ${triggers.pendingOccurrenceId} is not null then ${triggers.pendingOccurrenceAt}
        else ${requestedOccurrence.dueAt?.toISOString() ?? null}::timestamptz
      end`,
    })
    .where(
      and(
        eq(triggers.id, trigger.id),
        eq(triggers.deleted, false),
        or(
          and(
            eq(triggers.status, 'active'),
            trigger.pendingOccurrenceId === null
              ? and(
                  isNull(triggers.pendingOccurrenceId),
                  ...(requestedOccurrence.kind === 'scheduled' && requestedOccurrence.dueAt
                    ? [eq(triggers.nextScheduledRun, requestedOccurrence.dueAt)]
                    : []),
                )
              : and(
                  eq(triggers.pendingOccurrenceId, expectedOccurrenceId),
                  recoveryMarker,
                ),
          ),
          and(
            eq(triggers.status, 'paused'),
            eq(triggers.pendingOccurrenceId, expectedOccurrenceId),
            recoveryMarker,
          ),
        ),
      ),
    )
    .returning();
  if (claimed.length === 0) {
    throw new ApiError(409, 'task_not_active', `Task ${trigger.id} is already running`);
  }
  const durable = claimed[0]!;
  if (
    !durable.pendingOccurrenceId ||
    (durable.pendingOccurrenceKind !== 'manual' && durable.pendingOccurrenceKind !== 'scheduled') ||
    (durable.pendingOccurrenceKind === 'scheduled' && !durable.pendingOccurrenceAt)
  ) {
    throw new Error('scheduled task durable occurrence identity unavailable');
  }
  const occurrence: ScheduledTaskOccurrence = {
    id: durable.pendingOccurrenceId,
    kind: durable.pendingOccurrenceKind,
    dueAt: durable.pendingOccurrenceKind === 'scheduled' ? durable.pendingOccurrenceAt : null,
  };
  // Every downstream decision uses the row serialized by the claim, never
  // the scheduler/route snapshot read before a concurrent edit.
  trigger = pausedRecovery ? { ...durable, status: 'paused' } : durable;

  let outcome: TurnOutcome;
  let session: Session;
  try {
    // A completed provider/settlement pipeline leaves a unique usage row under
    // this deterministic turn id. Recover it before any new provider call.
    const recovered = await recoveredUsageOutcome(occurrence);
    if (recovered) {
      outcome = recovered.outcome;
      if (outcome.errorCode !== null) {
        await refundScheduledFailure(deps, trigger, occurrence, claimId);
      }
      const lastRunTime = await markTaskOutcome(
        deps,
        trigger,
        occurrence,
        claimId,
        outcome,
        recovered.sessionId,
        occurrence.kind === 'scheduled'
          ? occurrence.dueAt!
          : (trigger.lastRunTime ?? recovered.createdAt),
      );
      const result = {
        triggerId: trigger.id,
        sessionId: recovered.sessionId,
        outcome,
        lastRunTime: lastRunTime.toISOString(),
      };
      if (outcome.errorCode !== null) {
        throw new RecordedScheduledTaskError(
          502,
          outcome.errorCode,
          outcome.errorMessage ?? 'Recovered scheduled task failure',
        );
      }
      return result;
    }

    // recordUsageEvent is intentionally best-effort, so last_run_time is also
    // an idempotent occurrence checkpoint. It prevents a provider replay even
    // if the usage insert itself was the final operation lost in a crash.
    if (sameInstant(trigger.lastRunTime, occurrence.dueAt)) {
      const checkpointError = hasRecoveryMarker(trigger.lastError)
        ? null
        : trigger.lastError;
      outcome = {
        turnId: occurrence.id,
        userMessageId: occurrence.id,
        assistantMessageId: null,
        errorCode: checkpointError ? 'scheduled_task_checkpointed_failure' : null,
        errorMessage: checkpointError,
      };
      if (outcome.errorCode !== null) {
        await refundScheduledFailure(deps, trigger, occurrence, claimId);
      }
      const checkpointSessionId =
        trigger.sessionTarget === 'existing' && trigger.sessionExternalId
          ? trigger.sessionExternalId
          : occurrence.id;
      const lastRunTime = await markTaskOutcome(
        deps,
        trigger,
        occurrence,
        claimId,
        outcome,
        // A legacy last-run checkpoint without terminal usage is sufficient
        // to suppress provider replay, but it is not authoritative evidence
        // for a new completion notification.
        null,
      );
      if (outcome.errorCode !== null) {
        throw new RecordedScheduledTaskError(502, outcome.errorCode, outcome.errorMessage!);
      }
      return {
        triggerId: trigger.id,
        sessionId: checkpointSessionId,
        outcome,
        lastRunTime: lastRunTime.toISOString(),
      };
    }

    // Debit precedes every provider handoff. If either the reservation or its
    // positive settlement adjustment exists without a terminal
    // usage/checkpoint, a prior process died in the ambiguous window. Never
    // re-send that agent action: reverse both legs idempotently and fail this
    // occurrence. Settlement is reversed first, matching runTurn's refund
    // order, so a partial outage cannot temporarily over-credit the account.
    if (trigger.agentId) {
      const reservationKey = automationLedgerKey(trigger.agentId, occurrence.id);
      const settlementKey = automationLedgerKey(trigger.agentId, occurrence.id, 'settle');
      const [existingDebit] = await db
        .select({ id: mannaTransactions.id })
        .from(mannaTransactions)
        .where(
          inArray(mannaTransactions.idempotencyKey, [settlementKey, reservationKey]),
        )
        .limit(1);
      if (existingDebit) {
        await refundScheduledFailure(deps, trigger, occurrence, claimId);
        const recoveryError = new RecordedScheduledTaskError(
          502,
          SCHEDULED_TASK_INDETERMINATE,
          'A prior scheduled occurrence reached funding but not a terminal record; it was not re-executed',
        );
        await markTaskError(deps, trigger, occurrence, claimId, recoveryError);
        throw recoveryError;
      }
    }

    // A stale/refund marker is an explicit compensation-only checkpoint. The
    // absence of usage, an occurrence checkpoint, and ledger rows means the
    // old process died before funding. Verify both deterministic reversals
    // idempotently anyway, terminally fail/clear the occurrence, and never
    // hand the prompt to the provider.
    if (recoveryOnly) {
      await refundScheduledFailure(deps, trigger, occurrence, claimId);
      const recoveryError = new RecordedScheduledTaskError(
        502,
        SCHEDULED_TASK_INDETERMINATE,
        'A stale scheduled occurrence had no terminal record and was closed without provider replay',
      );
      await markTaskError(deps, trigger, occurrence, claimId, recoveryError);
      throw recoveryError;
    }

    const content = trigger.prompt?.trim();
    if (!content) throw new ApiError(409, 'task_missing_prompt', `Task ${trigger.id} has no prompt`);
    if (!deps.compat || !deps.bus || !deps.registry || !deps.historySync) {
      throw new ApiError(
        503,
        'gateway_unavailable',
        'Scheduled task provider runtime is unavailable',
      );
    }
    const owner = await loadTaskOwner(trigger);
    const agent = await loadTaskAgent(trigger);
    // Agent autonomy has a tighter rolling budget than ordinary interactive
    // chat. This is after the claim but before session/provider work; failures
    // are checkpointed like every other real scheduled attempt.
    await assertAutomationBudget(agent.accountId);
    session = await resolveRunSession(trigger, owner, agent, occurrence);
    const claim = {
      triggerId: trigger.id,
      occurrenceId: occurrence.id,
      claimId,
      sessionId: session.id,
    };
    outcome = await runTurn(
      {
        compat: deps.compat,
        bus: deps.bus,
        registry: deps.registry,
        historySync: deps.historySync,
        ...(deps.onError ? { onError: deps.onError } : {}),
      },
      {
        session,
        agent,
        user: owner,
        content,
        source: {
          kind: 'scheduled_task',
          triggerId: trigger.id,
          triggerExternalId: trigger.externalId,
          occurrenceId: occurrence.id,
          occurrenceAt: occurrence.dueAt?.toISOString() ?? null,
        },
        beginStream: emptySink,
        turnId: occurrence.id,
        beforeDebit: async () => {
          await deps.beforeLeaseRenewal?.(claim);
        },
        fundingFence: (dbc) => fenceScheduledTaskExecution(claim, dbc),
        beforeProvider: () => fenceScheduledTaskExecution(claim, db),
        beforeTerminal: () => fenceScheduledTaskExecution(claim, db),
        ...(deps.beforeTerminalPersistence
          ? { beforeTerminalPersistence: deps.beforeTerminalPersistence }
          : {}),
      },
    );
    if (outcome.emptyTurn === true && outcome.errorCode === null) {
      outcome.errorCode = SCHEDULED_TASK_EMPTY_RESPONSE;
      outcome.errorMessage = 'Scheduled task completed without an assistant response';
    }
  } catch (err) {
    if (err instanceof TurnClaimLostError) throw err;
    if (err instanceof RecordedScheduledTaskError) throw err;
    if (err instanceof ApiError && err.code === SCHEDULED_TASK_REFUND_PENDING) throw err;
    await refundScheduledFailure(deps, trigger, occurrence, claimId);
    await markTaskError(deps, trigger, occurrence, claimId, err);
    if (
      err instanceof RollingSpendCapExceededError &&
      err.scope === AUTOMATION_BUDGET_SCOPE
    ) {
      throw new RecordedScheduledTaskError(
        429,
        AUTOMATION_HOURLY_BUDGET_ERROR,
        err.message,
      );
    }
    if (err instanceof ApiError) {
      throw new RecordedScheduledTaskError(err.statusCode, err.code, err.message);
    }
    throw err;
  }

  if (outcome.errorCode !== null) {
    await refundScheduledFailure(deps, trigger, occurrence, claimId);
  }
  const lastRunTime = await markTaskOutcome(
    deps,
    trigger,
    occurrence,
    claimId,
    outcome,
    session.id,
  );

  const result = {
    triggerId: trigger.id,
    sessionId: session.id,
    outcome,
    lastRunTime: lastRunTime.toISOString(),
  };
  if (outcome.errorCode !== null) {
    throw new RecordedScheduledTaskError(
      outcome.errorCode === AUTOMATION_HOURLY_BUDGET_ERROR ||
        outcome.errorCode === 'daily_manna_cap_exceeded'
        ? 429
        : 502,
      outcome.errorCode,
      outcome.errorMessage ?? 'Scheduled task failed',
    );
  }
  return result;
}
