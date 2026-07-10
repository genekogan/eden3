import {
  DailyCapExceededError,
  getEnv,
  InsufficientMannaError,
  isHex24,
  isUuid,
  PRICING,
  resolveAgentByUsername,
} from '@eden3/core';
import { db, pg, triggers, type Trigger } from '@eden3/db';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { ApiError, sendError } from '../errors';
import type { GatewayGlue } from '../gateway-glue';
import { triggerDtoFromEntity } from '../route-helpers';
import { concurrentTurnLimit, dailyMannaSpend } from '../services/chat-limits';
import { runScheduledTask } from '../services/scheduled-tasks';
import { nextOccurrence, TaskScheduleError } from '../services/task-schedule';

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

const createBodySchema = z.object({
  agentUsername: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(10_000),
  schedule: scheduleSchema,
});

const patchBodySchema = z
  .object({
    status: z.enum(['active', 'paused']).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    prompt: z.string().trim().min(1).max(10_000).optional(),
    schedule: scheduleSchema.optional(),
    deleted: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.status !== undefined ||
      body.name !== undefined ||
      body.prompt !== undefined ||
      body.schedule !== undefined ||
      body.deleted !== undefined,
    {
    message: 'provide status and/or deleted',
    },
  );

const idParamsSchema = z.object({ id: z.string().trim().min(1).max(200) });

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
    log.error({ err }, `gateway cron removal failed for trigger ${row.id}`);
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

async function scheduledTaskQuotaError(account: { accountId: string; isAdmin: boolean }): Promise<{
  statusCode: 429;
  code: 'task_quota_exceeded';
  message: string;
} | null> {
  if (account.isAdmin) return null;
  const limit = getEnv().MAX_SCHEDULED_TASKS_PER_USER;
  const [quota] = await pg<{ count: number }[]>`
    select count(*)::int as count
    from triggers
    where user_id = ${account.accountId}
      and deleted = false
  `;
  if ((quota?.count ?? 0) >= limit) {
    return {
      statusCode: 429,
      code: 'task_quota_exceeded',
      message: `Scheduled task limit reached (${limit} tasks)`,
    };
  }
  return null;
}

export const triggersRoutes: FastifyPluginAsync = async (app) => {
  // ---- GET /tasks — the signed-in user's triggers --------------------------
  app.get('/', { preHandler: app.requireAuth }, async (req) => {
    const viewer = req.account;
    if (!viewer) return null; // unreachable — requireAuth replied 401
    const rows = await db
      .select()
      .from(triggers)
      .where(and(eq(triggers.userId, viewer.accountId), eq(triggers.deleted, false)))
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
    const isOwner = viewer.isAdmin || viewer.accountId === agent.ownerId;
    if (!agent.public && !isOwner) {
      return sendError(reply, 404, 'agent_not_found', `No agent named "${body.agentUsername}"`);
    }

    const quotaError = await scheduledTaskQuotaError(viewer);
    if (quotaError) {
      return sendError(reply, quotaError.statusCode, quotaError.code, quotaError.message);
    }

    const [row] = await db
      .insert(triggers)
      .values({
        userId: viewer.accountId,
        agentId: agentAccount.id,
        name: body.name,
        prompt: body.prompt,
        schedule: body.schedule,
        status: 'active',
        sessionTarget: 'new',
        nextScheduledRun,
      })
      .returning();
    if (!row) throw new Error('triggers insert returned no row');

    const fresh = await ensureGatewayJobRemoved(app.gatewayGlue, req.log, row);
    return reply.code(201).send({ task: triggerDtoFromEntity(fresh) });
  });

  // ---- POST /tasks/:id/runs — fire one scheduled prompt now -----------------
  app.post('/:id/runs', { preHandler: app.requireAuth }, async (req, reply) => {
    const viewer = req.account;
    if (!viewer) return null; // unreachable — requireAuth replied 401
    const { id } = idParamsSchema.parse(req.params);

    const existing = await findTrigger(id);
    if (!existing || existing.deleted) {
      return sendError(reply, 404, 'task_not_found', `No task "${id}"`);
    }
    if (!viewer.isAdmin && existing.userId !== viewer.accountId) {
      return sendError(reply, 403, 'forbidden', 'Only the task owner can run it');
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

    const env = getEnv();
    const spentToday = await dailyMannaSpend(existing.userId);
    if (spentToday + PRICING.chatTurn > env.DAILY_MANNA_SPEND_CAP_PER_USER) {
      throw new ApiError(
        429,
        'daily_manna_cap_exceeded',
        `Daily manna cap exceeded: ${spentToday} spent today, cap is ${env.DAILY_MANNA_SPEND_CAP_PER_USER}`,
      );
    }

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
          onError: (err, context) => req.log.error({ err, context }, 'scheduled task side-error'),
        },
        existing,
      );
      return reply.code(201).send({ run });
    } catch (err) {
      if (err instanceof InsufficientMannaError) {
        throw new ApiError(
          402,
          'insufficient_manna',
          `Not enough manna: this run costs ${err.required}, you have ${err.available}`,
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
    if (!viewer.isAdmin && existing.userId !== viewer.accountId) {
      return sendError(reply, 403, 'forbidden', 'Only the task owner can modify it');
    }

    const nextDeleted = body.deleted === true;
    const nextStatus = nextDeleted ? (existing.status ?? 'paused') : (body.status ?? existing.status);
    const nextSchedule = body.schedule ?? existing.schedule ?? {};
    // 'running' = active with a run in flight — schedule edits keep it live.
    const enabled = !nextDeleted && (nextStatus === 'active' || nextStatus === 'running');

    // An enabled task must have a real upcoming run; paused/deleted tasks
    // carry none (resume recomputes, so a stale stamp can't "miss-fire").
    const nextScheduledRun = enabled ? nextRunFromSchedule(nextSchedule, new Date()) : null;

    const [updated] = await db
      .update(triggers)
      .set({
        ...(nextDeleted
          ? { deleted: true, status: 'finished' }
          : body.status !== undefined
            ? { status: body.status }
            : {}),
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
        ...(body.schedule !== undefined ? { schedule: body.schedule } : {}),
        nextScheduledRun,
        updatedAt: new Date(),
      })
      .where(eq(triggers.id, existing.id))
      .returning();
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
