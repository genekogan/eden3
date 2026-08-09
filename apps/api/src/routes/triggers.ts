import {
  DailyCapExceededError,
  getEnv,
  InsufficientMannaError,
  isHex24,
  isUuid,
  resolveAgentByUsername,
} from '@eden3/core';
import { agents, db, pg, triggers, type Trigger } from '@eden3/db';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { ApiError, logSafeRequestError, safeRequestErrorCallback, sendError } from '../errors';
import type { GatewayGlue } from '../gateway-glue';
import { triggerDtoFromEntity } from '../route-helpers';
import { concurrentTurnLimit } from '../services/chat-limits';
import { isPlatformEve, isPlatformEveAccountId } from '../services/default-assistant';
import { manualTaskOccurrence, runScheduledTask } from '../services/scheduled-tasks';
import { assertTurnAdmissible } from '../services/turns';
import { nextOccurrence, TaskScheduleError } from '../services/task-schedule';
import { agentTaskLimitError, MAX_ENABLED_TASKS_PER_AGENT } from '../services/task-limits';

/**
 * Tasks API — user-scheduled prompts ("triggers"). Registered under the
 * /tasks prefix (the web contract):
 *
 *   GET   /tasks          — the signed-in user's triggers, newest first
 *   POST  /tasks          — {agentUsername, name, prompt, schedule{…}} -> row
 *                           with next_scheduled_run stamped
 *   POST  /tasks/:id/runs — fire one scheduled prompt now (metered run)
 *   PATCH /tasks/:id      — {status: active|paused}, name/prompt/schedule
 *                           edits, and/or {deleted: true}
 *
 * FIRING IS EDEN3-SIDE: services/task-scheduler.ts polls next_scheduled_run
 * and executes due tasks through the metered runScheduledTask pipeline. The
 * old OpenClaw gateway-cron mirror is retired (it bypassed metering) — every
 * write here only ensures any legacy `eden3:<id>` gateway job is REMOVED.
 * Removal failures (gateway down, CLI device lacking the operator.admin
 * scope) never lose the row: the error lands in triggers.last_error.
 *
 * Schedules: the eden1 APScheduler dict (recurring) or {at: ISO-8601}
 * (one-time). next_scheduled_run is computed on create and on any PATCH that
 * leaves the task active; the scheduler re-stamps it after every fire.
 */

/** eden1-style APScheduler dict (snake_case). hour+minute required. */
const recurringScheduleSchema = z
  .object({
    minute: z.union([z.number().int(), z.string()]),
    hour: z.union([z.number().int(), z.string()]),
    day: z.union([z.number().int(), z.string()]).optional(),
    month: z.union([z.number().int(), z.string()]).optional(),
    day_of_week: z.union([z.number().int(), z.string()]).optional(),
    timezone: z.string().min(1).max(100).optional(),
  })
  .passthrough() // second/year/start_date/end_date tolerated (ignored)
  .refine((value) => !('at' in value), {
    message: 'a schedule is either recurring (hour/minute) or one-time (at), not both',
  });

/** One-time schedule: fire once at this instant. */
const oneTimeScheduleSchema = z
  .object({
    at: z.string().datetime({ offset: true }),
  })
  .strict();

const scheduleSchema = z.union([oneTimeScheduleSchema, recurringScheduleSchema]);

const sessionTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('new') }).strict(),
  z.object({ kind: z.literal('existing'), sessionId: z.string().uuid() }).strict(),
]);

const createBodySchema = z.object({
  agentUsername: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(10_000),
  schedule: scheduleSchema,
  sessionTarget: sessionTargetSchema.default({ kind: 'new' }),
});

const patchBodySchema = z
  .object({
    status: z.enum(['active', 'paused']).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    prompt: z.string().trim().min(1).max(10_000).optional(),
    schedule: scheduleSchema.optional(),
    sessionTarget: sessionTargetSchema.optional(),
    deleted: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.status !== undefined ||
      body.name !== undefined ||
      body.prompt !== undefined ||
      body.schedule !== undefined ||
      body.sessionTarget !== undefined ||
      body.deleted !== undefined,
    {
    message: 'provide status and/or deleted',
    },
  );

const idParamsSchema = z.object({ id: z.string().trim().min(1).max(200) });
const runBodySchema = z.object({ requestId: z.string().uuid() }).strict();
const TASK_OWNER_LOCK_SEED = 84;

/**
 * Next fire instant for a schedule, with TaskScheduleError mapped onto the
 * 400 envelope. A valid-but-exhausted schedule (a one-time `at` in the past,
 * or nothing within the scan cap) is also a 400: an active task that could
 * never fire is a user mistake, not a row to keep.
 */
function nextRunFromSchedule(schedule: unknown, from: Date): Date {
  let next: Date | null;
  try {
    next = nextOccurrence(schedule, from);
  } catch (err) {
    if (err instanceof TaskScheduleError) throw new ApiError(400, 'invalid_schedule', err.message);
    throw err;
  }
  if (next === null) {
    throw new ApiError(
      400,
      'invalid_schedule',
      'schedule has no upcoming occurrence (one-time schedules must be in the future)',
    );
  }
  return next;
}

async function findTrigger(ref: string): Promise<Trigger | null> {
  if (isUuid(ref)) {
    const [row] = await db.select().from(triggers).where(eq(triggers.id, ref.toLowerCase())).limit(1);
    return row ?? null;
  }
  if (isHex24(ref)) {
    const [row] = await db
      .select()
      .from(triggers)
      .where(eq(triggers.externalId, ref.toLowerCase()))
      .limit(1);
    return row ?? null;
  }
  return null;
}

/**
 * Ensure no `eden3:<id>` gateway cron job survives for this trigger (the
 * gateway firing path is retired; a leftover job would double-fire). Persists
 * the outcome (last_synced_at on success, last_error on failure) and returns
 * the re-read row. Never throws for gateway-side failures.
 */
async function ensureGatewayJobRemoved(
  glue: GatewayGlue,
  log: FastifyBaseLogger,
  row: Trigger,
): Promise<Trigger> {
  try {
    await glue.cronSync.removeTrigger(row.id);
    await db
      .update(triggers)
      .set({
        openclawJobId: null,
        lastSyncedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(triggers.id, row.id));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logSafeRequestError(
      log,
      err,
      { triggerId: row.id },
      'gateway cron removal failed',
    );
    await db
      .update(triggers)
      .set({
        lastError: message.slice(0, 2000),
        errorCount: (row.errorCount ?? 0) + 1,
        updatedAt: new Date(),
      })
      .where(eq(triggers.id, row.id));
  }
  const [fresh] = await db.select().from(triggers).where(eq(triggers.id, row.id)).limit(1);
  return fresh ?? row;
}

/**
 * Latest run session per trigger, resolved from usage_events (each metered
 * run records metadata.source = {kind:'scheduled_task', triggerId} plus the
 * session it wrote into). `userId` scopes the scan onto
 * usage_events_user_created_idx.
 */
async function lastRunSessionIds(
  userId: string,
  triggerIds: string[],
): Promise<Map<string, string>> {
  if (triggerIds.length === 0) return new Map();
  const rows = await pg<{ trigger_id: string; session_id: string }[]>`
    select distinct on (metadata->'source'->>'triggerId')
      metadata->'source'->>'triggerId' as trigger_id,
      session_id
    from usage_events
    where user_id = ${userId}
      and session_id is not null
      and metadata->'source'->>'kind' = 'scheduled_task'
      and metadata->'source'->>'triggerId' = any(${triggerIds})
    order by metadata->'source'->>'triggerId', created_at desc
  `;
  return new Map(rows.map((row) => [row.trigger_id, row.session_id]));
}

const listTasksQuerySchema = z.object({
  /** Filter to one agent's tasks (username). */
  agent: z.string().trim().min(1).max(200).optional(),
});

export const triggersRoutes: FastifyPluginAsync = async (app) => {
  // ---- GET /tasks — the signed-in user's triggers --------------------------
  app.get('/', { preHandler: app.requireAuth }, async (req) => {
    const viewer = req.account;
    if (!viewer) return null; // unreachable — requireAuth replied 401
    const { agent } = listTasksQuerySchema.parse(req.query);
    const conditions = [eq(triggers.userId, viewer.accountId), eq(triggers.deleted, false)];
    if (agent !== undefined) {
      const resolved = await resolveAgentByUsername(agent);
      if (!resolved) return { items: [], nextCursor: null };
      conditions.push(eq(triggers.agentId, resolved.account.id));
    }
    const rows = await db
      .select()
      .from(triggers)
      .where(and(...conditions))
      .orderBy(desc(triggers.createdAt), desc(triggers.id))
      .limit(200);
    const sessions = await lastRunSessionIds(
      viewer.accountId,
      rows.map((row) => row.id),
    );
    return {
      items: rows.map((row) =>
        triggerDtoFromEntity(row, { lastRunSessionId: sessions.get(row.id) ?? null }),
      ),
      nextCursor: null,
    };
  });

  // ---- POST /tasks — create (next run stamped; no gateway job) -------------
  app.post('/', { preHandler: app.requireAuth }, async (req, reply) => {
    const viewer = req.account;
    if (!viewer) return null; // unreachable — requireAuth replied 401
    const body = createBodySchema.parse(req.body);
    const nextScheduledRun = nextRunFromSchedule(body.schedule, new Date());

    const resolved = await resolveAgentByUsername(body.agentUsername);
    if (!resolved) {
      return sendError(reply, 404, 'agent_not_found', `No agent named "${body.agentUsername}"`);
    }
    const { account: agentAccount, agent } = resolved;
    if (isPlatformEve(agentAccount, agent)) {
      return sendError(
        reply,
        403,
        'eve_configuration_hidden',
        'Eve is platform-owned and cannot be configured with scheduled tasks',
      );
    }
    if (viewer.accountId !== agent.ownerId) {
      return sendError(reply, 404, 'agent_not_found', `No agent named "${body.agentUsername}"`);
    }

    const ownerTaskLimit = getEnv().MAX_SCHEDULED_TASKS_PER_USER;

    // Every task creator takes the owner lock before the agent lock. The
    // owner-wide retained-row quota therefore composes with self-cron creates
    // across different agents, while the existing enabled-task cap remains
    // exact for this agent.
    const rowId = await pg.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${
        `task-owner:${viewer.accountId}`
      }::text, ${TASK_OWNER_LOCK_SEED}))`;
      const [quota] = await tx<{ count: number }[]>`
        select count(*)::int as count
        from triggers
        where user_id = ${viewer.accountId}
          and deleted = false
      `;
      if ((quota?.count ?? 0) >= ownerTaskLimit) {
        throw new ApiError(
          429,
          'task_quota_exceeded',
          `Scheduled task limit reached (${ownerTaskLimit} tasks)`,
        );
      }
      await tx`select pg_advisory_xact_lock(hashtextextended(${agentAccount.id}::text, 84))`;
      const [enabled] = await tx<{ count: number }[]>`
        select count(*)::int as count
        from triggers
        where agent_id = ${agentAccount.id}
          and deleted = false
          and status in ('active', 'running')
      `;
      if ((enabled?.count ?? 0) >= MAX_ENABLED_TASKS_PER_AGENT) {
        throw agentTaskLimitError(agentAccount.id);
      }
      if (body.sessionTarget.kind === 'existing') {
        const [target] = await tx<{ id: string }[]>`
          select s.id
          from sessions s
          where s.id = ${body.sessionTarget.sessionId}::uuid
            and s.owner_id = ${viewer.accountId}
            and s.deleted = false
            and s.visible is distinct from false
            and s.channel_connection_id is null
            and s.session_type is distinct from 'channel'
            and exists (
              select 1 from session_agents sa
              where sa.session_id = s.id
                and sa.agent_account_id = ${agentAccount.id}
            )
          for key share of s
        `;
        if (!target) {
          throw new ApiError(
            409,
            'task_session_unavailable',
            'The selected output session is unavailable for this agent',
          );
        }
      }
      const [inserted] = await tx<{ id: string }[]>`
        insert into triggers (
          user_id, agent_id, name, prompt, schedule, status,
          session_target, session_external_id, next_scheduled_run
        ) values (
          ${viewer.accountId}, ${agentAccount.id}, ${body.name}, ${body.prompt},
          ${JSON.stringify(body.schedule)}::jsonb, 'active', ${body.sessionTarget.kind},
          ${body.sessionTarget.kind === 'existing' ? body.sessionTarget.sessionId : null},
          ${nextScheduledRun.toISOString()}
        )
        returning id
      `;
      if (!inserted) throw new Error('triggers insert returned no row');
      return inserted.id;
    });
    const [row] = await db.select().from(triggers).where(eq(triggers.id, rowId)).limit(1);
    if (!row) throw new Error('triggers insert returned no row');

    const fresh = await ensureGatewayJobRemoved(app.gatewayGlue, req.log, row);
    return reply.code(201).send({ task: triggerDtoFromEntity(fresh) });
  });

  // ---- POST /tasks/:id/runs — fire one scheduled prompt now -----------------
  app.post('/:id/runs', { preHandler: app.requireAuth }, async (req, reply) => {
    const viewer = req.account;
    if (!viewer) return null; // unreachable — requireAuth replied 401
    const { id } = idParamsSchema.parse(req.params);
    const { requestId } = runBodySchema.parse(req.body);

    const existing = await findTrigger(id);
    if (!existing || existing.deleted) {
      return sendError(reply, 404, 'task_not_found', `No task "${id}"`);
    }
    if (existing.userId !== viewer.accountId) {
      return sendError(reply, 403, 'forbidden', 'Only the task owner can run it');
    }
    if (await isPlatformEveAccountId(existing.agentId)) {
      return sendError(
        reply,
        403,
        'eve_configuration_hidden',
        'Eve is platform-owned and cannot run user-configured scheduled tasks',
      );
    }
    if (!app.gatewayCompat || !app.historySync) {
      throw new ApiError(
        503,
        'gateway_not_configured',
        'OPENCLAW_GATEWAY_TOKEN is not configured — scheduled task runs are unavailable',
      );
    }
    if (!existing.userId) {
      throw new ApiError(409, 'task_missing_owner', `Task ${existing.id} has no owner`);
    }

    // Friendly worst-case-reserve pre-check for the task agent's route
    // (race-free authority = the in-debit reservation check).
    let taskModel: string | undefined;
    if (existing.agentId) {
      const [agentRow] = await db
        .select({ model: agents.model })
        .from(agents)
        .where(eq(agents.accountId, existing.agentId))
        .limit(1);
      taskModel = agentRow?.model ?? undefined;
    }
    await assertTurnAdmissible(existing.userId, taskModel);

    const turnLimit = await concurrentTurnLimit(existing.userId);
    const releaseTurn = app.turnLimiter.acquire(existing.userId, turnLimit.limit);
    if (!releaseTurn) {
      throw new ApiError(
        429,
        'turn_concurrency_exceeded',
        `Too many active scheduled turns: limit is ${turnLimit.limit}${turnLimit.tier ? ` for ${turnLimit.tier}` : ''}`,
      );
    }

    try {
      const run = await runScheduledTask(
        {
          compat: app.gatewayCompat,
          bus: app.eventsBus,
          registry: app.turnRegistry,
          historySync: app.historySync,
          onError: safeRequestErrorCallback(req.log, {}, 'scheduled task side-error'),
        },
        existing,
        manualTaskOccurrence(existing.id, requestId),
      );
      return reply.code(201).send({ run });
    } catch (err) {
      if (err instanceof InsufficientMannaError) {
        throw new ApiError(
          402,
          'insufficient_manna',
          `Not enough manna: this run reserves up to ${err.required} (unused is refunded when the turn settles), you have ${err.available}`,
        );
      }
      if (err instanceof DailyCapExceededError) {
        throw new ApiError(
          429,
          'daily_manna_cap_exceeded',
          `Daily manna cap exceeded: ${err.spentToday} spent today, cap is ${err.cap}`,
        );
      }
      throw err;
    } finally {
      releaseTurn();
    }
  });

  // ---- PATCH /tasks/:id — pause / resume / edit / delete -------------------
  app.patch('/:id', { preHandler: app.requireAuth }, async (req, reply) => {
    const viewer = req.account;
    if (!viewer) return null; // unreachable — requireAuth replied 401
    const { id } = idParamsSchema.parse(req.params);
    const body = patchBodySchema.parse(req.body);

    const existing = await findTrigger(id);
    if (!existing || existing.deleted) {
      return sendError(reply, 404, 'task_not_found', `No task "${id}"`);
    }
    if (existing.userId !== viewer.accountId) {
      return sendError(reply, 403, 'forbidden', 'Only the task owner can modify it');
    }
    if (await isPlatformEveAccountId(existing.agentId)) {
      return sendError(
        reply,
        403,
        'eve_configuration_hidden',
        'Eve is platform-owned and cannot be configured with scheduled tasks',
      );
    }

    const updatedId = await pg.begin(async (tx) => {
      // Always take the same per-agent lock as creates and bridge mutations,
      // then re-read this row under `for update`. Computing slot usage from
      // the pre-transaction route read lets a pause/resume race exceed ten.
      if (existing.agentId) {
        await tx`select pg_advisory_xact_lock(hashtextextended(${existing.agentId}::text, 84))`;
      }
      const [current] = await tx<{
        id: string;
        agent_id: string | null;
        deleted: boolean;
        status: string | null;
        name: string | null;
        prompt: string | null;
        schedule: unknown;
        session_target: string | null;
        session_external_id: string | null;
        pending_occurrence_id: string | null;
      }[]>`
        select id, agent_id, deleted, status, name, prompt, schedule,
               session_target, session_external_id,
               pending_occurrence_id
        from triggers
        where id = ${existing.id}
        for update
      `;
      if (!current || current.deleted) return null;
      const pauseOnly =
        body.status === 'paused' &&
        body.name === undefined &&
        body.prompt === undefined &&
        body.schedule === undefined &&
        body.sessionTarget === undefined &&
        body.deleted === undefined;
      if (current.pending_occurrence_id && !pauseOnly) {
        throw new ApiError(
          409,
          'task_refund_pending',
          'This task has a run or charge recovery in progress; it may be paused, but retry other edits after recovery completes',
        );
      }

      const nextDeleted = body.deleted === true;
      const nextStatus = nextDeleted
        ? (current.status ?? 'paused')
        : (body.status ?? current.status);
      const nextSchedule = body.schedule ?? current.schedule ?? {};
      const nextSessionTarget = body.sessionTarget?.kind ?? current.session_target ?? 'new';
      const nextSessionExternalId = body.sessionTarget
        ? body.sessionTarget.kind === 'existing'
          ? body.sessionTarget.sessionId
          : null
        : current.session_external_id;
      // 'running' = active with a run in flight — schedule edits keep it live.
      const enabled = !nextDeleted && (nextStatus === 'active' || nextStatus === 'running');
      const wasEnabled = current.status === 'active' || current.status === 'running';
      const claimsNewSlot = enabled && !wasEnabled;
      const nextScheduledRun = enabled
        ? nextRunFromSchedule(nextSchedule, new Date())
        : null;

      if (claimsNewSlot && current.agent_id) {
        const [count] = await tx<{ count: number }[]>`
          select count(*)::int as count
          from triggers
          where agent_id = ${current.agent_id}
            and deleted = false
            and status in ('active', 'running')
        `;
        if ((count?.count ?? 0) >= MAX_ENABLED_TASKS_PER_AGENT) {
          throw agentTaskLimitError(current.agent_id);
        }
      }
      if (body.sessionTarget?.kind === 'existing' && current.agent_id) {
        const [target] = await tx<{ id: string }[]>`
          select s.id
          from sessions s
          where s.id = ${body.sessionTarget.sessionId}::uuid
            and s.owner_id = ${viewer.accountId}
            and s.deleted = false
            and s.visible is distinct from false
            and s.channel_connection_id is null
            and s.session_type is distinct from 'channel'
            and exists (
              select 1 from session_agents sa
              where sa.session_id = s.id
                and sa.agent_account_id = ${current.agent_id}
            )
          for key share of s
        `;
        if (!target) {
          throw new ApiError(
            409,
            'task_session_unavailable',
            'The selected output session is unavailable for this agent',
          );
        }
      }
      const [changed] = await tx<{ id: string }[]>`
        update triggers
        set deleted = ${nextDeleted},
            status = ${nextDeleted ? 'finished' : nextStatus},
            name = ${body.name ?? current.name},
            prompt = ${body.prompt ?? current.prompt},
            schedule = ${JSON.stringify(nextSchedule)}::jsonb,
            session_target = ${nextSessionTarget},
            session_external_id = ${nextSessionExternalId},
            next_scheduled_run = ${nextScheduledRun?.toISOString() ?? null},
            updated_at = now()
        where id = ${existing.id}
        returning id
      `;
      return changed?.id ?? null;
    });
    const [updated] = updatedId
      ? await db.select().from(triggers).where(eq(triggers.id, updatedId)).limit(1)
      : [];
    if (!updated) {
      return sendError(reply, 404, 'task_not_found', `No task "${id}"`);
    }

    const fresh = await ensureGatewayJobRemoved(app.gatewayGlue, req.log, updated);
    const sessions = existing.userId
      ? await lastRunSessionIds(existing.userId, [existing.id])
      : new Map<string, string>();
    return {
      task: triggerDtoFromEntity(fresh, {
        lastRunSessionId: sessions.get(existing.id) ?? null,
      }),
    };
  });
};
