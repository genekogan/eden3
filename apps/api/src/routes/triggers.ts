import { isHex24, isUuid, resolveAgentByUsername } from '@eden3/core';
import { agents, db, triggers, type Trigger } from '@eden3/db';
import { CronSyncError, scheduleToCron, type EdenSchedule } from '@eden3/gateway';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { ApiError, sendError } from '../errors';
import type { GatewayGlue } from '../gateway-glue';
import { triggerDtoFromEntity } from '../route-helpers';

/**
 * Tasks API — user-scheduled prompts ("triggers"), synced to OpenClaw cron
 * jobs. Registered under the /tasks prefix (the web contract):
 *
 *   GET   /tasks     — the signed-in user's triggers, newest first
 *   POST  /tasks     — {agentUsername, name, prompt, schedule{…}} -> row +
 *                      gateway cron-sync (job name eden3:<trigger uuid>)
 *   PATCH /tasks/:id — {status: active|paused} and/or {deleted: true} ->
 *                      update + cron-sync (resume re-adds, pause/delete removes)
 *
 * Cron-sync failures (gateway down, CLI device lacking the operator.admin
 * scope) never lose the row: the error lands in triggers.last_error and the
 * next successful sync converges (jobs are reconciled by name).
 */

/** eden1-style APScheduler dict (snake_case). hour+minute required. */
const scheduleSchema = z
  .object({
    minute: z.union([z.number().int(), z.string()]),
    hour: z.union([z.number().int(), z.string()]),
    day: z.union([z.number().int(), z.string()]).optional(),
    month: z.union([z.number().int(), z.string()]).optional(),
    day_of_week: z.union([z.number().int(), z.string()]).optional(),
    timezone: z.string().min(1).max(100).optional(),
  })
  .passthrough(); // second/year/start_date/end_date tolerated (ignored)

const createBodySchema = z.object({
  agentUsername: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(10_000),
  schedule: scheduleSchema,
});

const patchBodySchema = z
  .object({
    status: z.enum(['active', 'paused']).optional(),
    deleted: z.literal(true).optional(),
  })
  .strict()
  .refine((body) => body.status !== undefined || body.deleted !== undefined, {
    message: 'provide status and/or deleted',
  });

const idParamsSchema = z.object({ id: z.string().trim().min(1).max(200) });

/** scheduleToCron with CronSyncError mapped onto the 400 envelope. */
function cronFromSchedule(schedule: EdenSchedule): { cron: string; tz?: string } {
  try {
    return scheduleToCron(schedule);
  } catch (err) {
    if (err instanceof CronSyncError) throw new ApiError(400, 'invalid_schedule', err.message);
    throw err;
  }
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
 * Reconcile one trigger with the gateway and persist the outcome
 * (openclaw_job_id / last_synced_at on success, last_error on failure).
 * Returns the re-read row. Never throws for gateway-side failures.
 */
async function syncTriggerRow(
  glue: GatewayGlue,
  log: FastifyBaseLogger,
  row: Trigger,
  params: { openclawAgentId: string; cron: string; tz?: string; enabled: boolean },
): Promise<Trigger> {
  try {
    const result = await glue.cronSync.syncTrigger({
      triggerId: row.id,
      openclawAgentId: params.openclawAgentId,
      cronExpr: params.cron,
      ...(params.tz !== undefined ? { tz: params.tz } : {}),
      prompt: row.prompt ?? '',
      enabled: params.enabled,
    });
    await db
      .update(triggers)
      .set({
        openclawJobId: params.enabled ? (result.jobId ?? null) : null,
        lastSyncedAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(triggers.id, row.id));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, `cron-sync failed for trigger ${row.id}`);
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

/** The gateway agent id for a trigger's agent account (null = not linked). */
async function openclawAgentIdFor(agentAccountId: string | null): Promise<string | null> {
  if (agentAccountId === null) return null;
  const [row] = await db
    .select({ openclawId: agents.openclawId })
    .from(agents)
    .where(eq(agents.accountId, agentAccountId))
    .limit(1);
  return row?.openclawId ?? null;
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
    return { items: rows.map(triggerDtoFromEntity), nextCursor: null };
  });

  // ---- POST /tasks — create + cron-sync ------------------------------------
  app.post('/', { preHandler: app.requireAuth }, async (req, reply) => {
    const viewer = req.account;
    if (!viewer) return null; // unreachable — requireAuth replied 401
    const body = createBodySchema.parse(req.body);
    const { cron, tz } = cronFromSchedule(body.schedule as EdenSchedule);

    const resolved = await resolveAgentByUsername(body.agentUsername);
    if (!resolved) {
      return sendError(reply, 404, 'agent_not_found', `No agent named "${body.agentUsername}"`);
    }
    const { account: agentAccount, agent } = resolved;
    const isOwner = viewer.isAdmin || viewer.accountId === agent.ownerId;
    if (!agent.public && !isOwner) {
      return sendError(reply, 404, 'agent_not_found', `No agent named "${body.agentUsername}"`);
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
      })
      .returning();
    if (!row) throw new Error('triggers insert returned no row');

    const openclawAgentId = agent.openclawId ?? agentAccount.username;
    const fresh = await syncTriggerRow(app.gatewayGlue, req.log, row, {
      openclawAgentId,
      cron,
      ...(tz !== undefined ? { tz } : {}),
      enabled: true,
    });
    return reply.code(201).send({ task: triggerDtoFromEntity(fresh) });
  });

  // ---- PATCH /tasks/:id — pause / resume / delete --------------------------
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
    const enabled = !nextDeleted && nextStatus === 'active';

    // Re-enabling needs a valid stored schedule; removal needs no cron at all.
    let cron = '';
    let tz: string | undefined;
    if (enabled) {
      ({ cron, tz } = cronFromSchedule((existing.schedule ?? {}) as EdenSchedule));
    }

    const [updated] = await db
      .update(triggers)
      .set({
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(nextDeleted ? { deleted: true } : {}),
        updatedAt: new Date(),
      })
      .where(eq(triggers.id, existing.id))
      .returning();
    if (!updated) {
      return sendError(reply, 404, 'task_not_found', `No task "${id}"`);
    }

    const openclawAgentId = (await openclawAgentIdFor(existing.agentId)) ?? '';
    const fresh = await syncTriggerRow(app.gatewayGlue, req.log, updated, {
      openclawAgentId,
      cron,
      ...(tz !== undefined ? { tz } : {}),
      enabled,
    });
    return { task: triggerDtoFromEntity(fresh) };
  });
};
