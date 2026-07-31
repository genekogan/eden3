import { randomUUID } from 'node:crypto';

import { gatewaySessionKey, resolveSession, type AuthSession } from '@eden3/core';
import { accounts, agents, db, sessionAgents, sessionUsers, sessions, triggers, type Session, type Trigger } from '@eden3/db';
import { DEFAULT_AGENT_MODEL, DEFAULT_AGENT_THINKING_LEVEL } from '@eden3/shared';
import { and, eq, sql } from 'drizzle-orm';

import { ApiError } from '../errors';
import type { EventsBus } from '../events-bus';
import type { HistorySync } from './history-sync';
import type { TurnRegistry } from './turn-registry';
import { runTurn, type CompatClientLike, type TurnAgent, type TurnOutcome, type TurnSink } from './turns';

interface ScheduledRunDeps {
  compat: CompatClientLike;
  bus: EventsBus;
  registry: TurnRegistry;
  historySync: HistorySync;
  onError?: (err: unknown, context: string) => void;
}

export interface ScheduledRunResult {
  triggerId: string;
  sessionId: string;
  outcome: TurnOutcome;
  lastRunTime: string;
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
    .select({ id: accounts.id, username: accounts.username, deleted: accounts.deleted })
    .from(accounts)
    .where(eq(accounts.id, trigger.userId))
    .limit(1);
  if (!owner || owner.deleted) {
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
  if (!row.openclawId || row.provisionStatus !== 'ready') {
    throw new ApiError(409, 'task_agent_not_ready', `Task ${trigger.id} agent is not ready`);
  }
  return {
    accountId: row.accountId,
    username: row.username,
    openclawId: row.openclawId,
    model: row.model ?? DEFAULT_AGENT_MODEL,
    thinkingLevel: row.thinkingLevel ?? DEFAULT_AGENT_THINKING_LEVEL,
  };
}

async function createRunSession(trigger: Trigger, owner: AuthSession, agent: TurnAgent): Promise<Session> {
  const sessionId = randomUUID();
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
      .returning();
    if (!row) throw new Error('scheduled task session insert returned no row');
    await tx.insert(sessionAgents).values({ sessionId, agentAccountId: agent.accountId });
    await tx.insert(sessionUsers).values({ sessionId, userAccountId: owner.accountId });
    return [row] as const;
  });
  return session;
}

async function resolveRunSession(
  trigger: Trigger,
  owner: AuthSession,
  agent: TurnAgent,
): Promise<Session> {
  if (trigger.sessionTarget === 'existing' && trigger.sessionExternalId) {
    const existing = await resolveSession(trigger.sessionExternalId);
    if (existing && existing.ownerId === owner.accountId) {
      if (existing.gatewaySessionKey) return existing;
      const [updated] = await db
        .update(sessions)
        .set({ gatewaySessionKey: gatewaySessionKey(existing.id), updatedAt: new Date() })
        .where(eq(sessions.id, existing.id))
        .returning();
      if (updated) return updated;
    }
  }
  return await createRunSession(trigger, owner, agent);
}

async function markTaskError(trigger: Trigger, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await db
    .update(triggers)
    .set({
      status: trigger.status === 'running' ? 'active' : (trigger.status ?? 'active'),
      lastError: message.slice(0, 2000),
      errorCount: sql`coalesce(${triggers.errorCount}, 0) + 1`,
      updatedAt: new Date(),
    })
    .where(eq(triggers.id, trigger.id));
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
): Promise<ScheduledRunResult> {
  if (trigger.deleted) throw new ApiError(404, 'task_not_found', `No task "${trigger.id}"`);
  if (trigger.status !== 'active') {
    throw new ApiError(409, 'task_not_active', `Task ${trigger.id} is not active`);
  }
  const content = trigger.prompt?.trim();
  if (!content) throw new ApiError(409, 'task_missing_prompt', `Task ${trigger.id} has no prompt`);

  const owner = await loadTaskOwner(trigger);
  const agent = await loadTaskAgent(trigger);
  const session = await resolveRunSession(trigger, owner, agent);

  // Atomic active->running claim: two concurrent fire requests (user +
  // admin, or a retried scheduler tick) cannot both run the task — the loser
  // sees zero rows claimed and 409s like any non-active task.
  const claimed = await db
    .update(triggers)
    .set({ status: 'running', lastError: null, updatedAt: new Date() })
    .where(and(eq(triggers.id, trigger.id), eq(triggers.status, 'active')))
    .returning({ id: triggers.id });
  if (claimed.length === 0) {
    throw new ApiError(409, 'task_not_active', `Task ${trigger.id} is already running`);
  }

  let outcome: TurnOutcome;
  try {
    outcome = await runTurn(deps, {
      session,
      agent,
      user: owner,
      content,
      source: {
        kind: 'scheduled_task',
        triggerId: trigger.id,
        triggerExternalId: trigger.externalId,
      },
      beginStream: emptySink,
    });
  } catch (err) {
    await markTaskError(trigger, err);
    throw err;
  }

  const lastRunTime = new Date();
  await db
    .update(triggers)
    .set({
      status: 'active',
      lastRunTime,
      lastError: outcome.errorCode,
      // error_count is a CONSECUTIVE-failure streak: a clean run resets it,
      // so the scheduler's auto-pause threshold only trips on unbroken runs
      // of failures, not on lifetime totals.
      errorCount: outcome.errorCode ? sql`coalesce(${triggers.errorCount}, 0) + 1` : 0,
      updatedAt: lastRunTime,
    })
    .where(eq(triggers.id, trigger.id));

  return {
    triggerId: trigger.id,
    sessionId: session.id,
    outcome,
    lastRunTime: lastRunTime.toISOString(),
  };
}
