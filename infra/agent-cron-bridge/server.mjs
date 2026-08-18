import { randomUUID } from 'node:crypto';
import { chmod, chown, lstat, mkdir, unlink } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { nextOccurrence, TaskScheduleError, validateSchedule } from './schedule.mjs';

export const PROTOCOL_VERSION = 1;
export const DEFAULT_SOCKET_PATH = '/run/eden3-cron/agent-cron.sock';
export const MAX_FRAME_BYTES = 262_144;
export const MAX_ENABLED_TASKS_PER_AGENT = 10;
export const MAX_RETAINED_SELF_CRON_TASKS_PER_AGENT = 50;
export const SELF_CRON_EXTERNAL_PREFIX = 'eden3-agent-cron:';
export const TASK_OWNER_LOCK_PREFIX = 'task-owner:';
export const TASK_OWNER_LOCK_SEED = 84;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AGENT_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

function databaseNameFromUrl(raw) {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') return null;
    const authorityStart = raw.indexOf('://') + 3;
    const firstDelimiterOffset = raw.slice(authorityStart).search(/[/?#]/);
    if (authorityStart < 3 || firstDelimiterOffset < 0) return null;
    const pathStart = authorityStart + firstDelimiterOffset;
    if (raw[pathStart] !== '/') return null;
    const pathTail = raw.slice(pathStart);
    const pathEndOffset = pathTail.search(/[?#]/);
    const rawPathname = pathEndOffset < 0 ? pathTail : pathTail.slice(0, pathEndOffset);
    return /^\/([A-Za-z0-9_-]+)$/.exec(rawPathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Fail closed when the sidecar and API URLs select different logical DBs. */
export function assertMatchingDatabaseSelection(databaseUrl, apiDatabaseUrl) {
  const sidecar = databaseNameFromUrl(databaseUrl);
  const api = databaseNameFromUrl(apiDatabaseUrl);
  if (sidecar === null || api === null || sidecar !== api) {
    throw new Error('cron bridge database selection does not match the API');
  }
  return sidecar;
}

export function parseScheduledTaskLimit(raw) {
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error('MAX_SCHEDULED_TASKS_PER_USER must be a nonnegative integer');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error('MAX_SCHEDULED_TASKS_PER_USER must be a nonnegative integer');
  }
  return value;
}

export class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

function object(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedText(value, name, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new BridgeError('invalid_request', `${name} must be a non-empty string of at most ${max} characters`);
  }
  return value.trim();
}

function taskId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new BridgeError('invalid_request', 'taskId must be a UUID');
  }
  return value.toLowerCase();
}

export function sessionIdFromContext(agentId, sessionKey) {
  if (typeof sessionKey !== 'string' || sessionKey.length > 512) return null;
  let canonical = sessionKey;
  if (canonical.startsWith('agent:')) {
    const prefix = `agent:${agentId}:`;
    if (!canonical.startsWith(prefix)) return null;
    canonical = canonical.slice(prefix.length);
  }
  if (!canonical.startsWith('eden3:s:')) return null;
  const id = canonical.slice('eden3:s:'.length);
  return UUID.test(id) ? id.toLowerCase() : null;
}

export function parseBridgeRequest(input) {
  if (!object(input) || input.protocolVersion !== PROTOCOL_VERSION) {
    throw new BridgeError('invalid_request', 'invalid cron bridge request');
  }
  const agentId = boundedText(input.agentId, 'agentId', 128);
  if (!AGENT_ID.test(agentId)) throw new BridgeError('invalid_request', 'invalid agentId');
  const sessionKey = boundedText(input.sessionKey, 'sessionKey', 512);
  const args = input.args === undefined ? {} : input.args;
  if (!object(args)) throw new BridgeError('invalid_request', 'args must be an object');
  if (!['list', 'create', 'update', 'delete'].includes(input.action)) {
    throw new BridgeError('invalid_request', 'action must be list, create, update, or delete');
  }
  return { agentId, sessionKey, action: input.action, args };
}

const RECURRING_SCHEDULE_KEYS = new Set([
  'minute',
  'hour',
  'day',
  'month',
  'day_of_week',
  'timezone',
]);

function validateAgentSchedule(schedule) {
  try {
    if (!object(schedule)) throw new TaskScheduleError('schedule must be an object');
    const allowed = Object.hasOwn(schedule, 'at') ? new Set(['at']) : RECURRING_SCHEDULE_KEYS;
    const unknown = Object.keys(schedule).find((key) => !allowed.has(key));
    if (unknown) throw new TaskScheduleError(`schedule.${unknown} is not supported`);
    for (const [key, value] of Object.entries(schedule)) {
      if (typeof value === 'string' && value.length > 100) {
        throw new TaskScheduleError(`schedule.${key} must be at most 100 characters`);
      }
    }
    validateSchedule(schedule);
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    if (error instanceof TaskScheduleError) {
      throw new BridgeError('invalid_schedule', error.message);
    }
    throw error;
  }
}

function requireUpcoming(schedule, now) {
  validateAgentSchedule(schedule);
  let next;
  try {
    next = nextOccurrence(schedule, now);
  } catch (error) {
    if (error instanceof TaskScheduleError) {
      throw new BridgeError('invalid_schedule', error.message);
    }
    throw error;
  }
  if (!next) {
    throw new BridgeError(
      'invalid_schedule',
      'schedule has no upcoming occurrence (one-time schedules must be in the future)',
    );
  }
  return next;
}

/** Pure protocol dispatcher; the injected store owns transactional limits. */
export async function handleBridgeRequest(input, store, options = {}) {
  const request = parseBridgeRequest(input);
  const sessionId = sessionIdFromContext(request.agentId, request.sessionKey);
  if (!sessionId) throw new BridgeError('forbidden', 'cron is available only in an Eden task-owner session');
  const identity = await store.resolveIdentity(request.agentId, sessionId);
  if (!identity) throw new BridgeError('forbidden', 'cron is available only in an Eden task-owner session');
  const now = options.now?.() ?? new Date();

  if (request.action === 'list') return { tasks: await store.list(identity) };
  if (request.action === 'create') {
    const name = boundedText(request.args.name, 'name', 200);
    const prompt = boundedText(request.args.prompt, 'prompt', 10_000);
    const schedule = request.args.schedule;
    const nextScheduledRun = requireUpcoming(schedule, now);
    return { task: await store.create(identity, { name, prompt, schedule, nextScheduledRun }) };
  }

  const id = taskId(request.args.taskId);
  if (request.action === 'delete') return { task: await store.remove(identity, id) };
  const patch = {};
  if (request.args.name !== undefined) patch.name = boundedText(request.args.name, 'name', 200);
  if (request.args.prompt !== undefined) patch.prompt = boundedText(request.args.prompt, 'prompt', 10_000);
  if (request.args.enabled !== undefined) {
    if (typeof request.args.enabled !== 'boolean') throw new BridgeError('invalid_request', 'enabled must be boolean');
    patch.enabled = request.args.enabled;
  }
  if (request.args.schedule !== undefined) {
    validateAgentSchedule(request.args.schedule);
    patch.schedule = request.args.schedule;
  }
  if (Object.keys(patch).length === 0) throw new BridgeError('invalid_request', 'update needs at least one changed field');
  return { task: await store.update(identity, id, patch, now) };
}

function mapTask(row) {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    schedule: row.schedule,
    status: row.status,
    nextScheduledRun: row.next_scheduled_run ? new Date(row.next_scheduled_run).toISOString() : null,
    lastRunTime: row.last_run_time ? new Date(row.last_run_time).toISOString() : null,
    lastError: row.last_error,
  };
}

export function createPostgresTaskStore(sql, options = {}) {
  const maxScheduledTasksPerUser = options.maxScheduledTasksPerUser;
  if (!Number.isSafeInteger(maxScheduledTasksPerUser) || maxScheduledTasksPerUser < 0) {
    throw new Error('maxScheduledTasksPerUser must be a nonnegative integer');
  }
  const ownedTask = async (query, identity, id, lock = false) => {
    const rows = await query`
      select id, name, prompt, schedule, status, next_scheduled_run,
             last_run_time, last_error, deleted
      from triggers
      where id = ${id}
        and user_id = ${identity.ownerId}
        and agent_id = ${identity.agentAccountId}
        and external_id like ${`${SELF_CRON_EXTERNAL_PREFIX}%`}
        and deleted = false
      limit 1
      ${lock ? query`for update` : query``}
    `;
    if (!rows[0]) throw new BridgeError('task_not_found', `No agent-created task "${id}"`);
    return rows[0];
  };

  const lockAgent = async (tx, identity) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${identity.agentAccountId}::text, 84))`;
  };

  const lockOwner = async (tx, identity) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${
      `${TASK_OWNER_LOCK_PREFIX}${identity.ownerId}`
    }::text, ${TASK_OWNER_LOCK_SEED}))`;
  };

  const assertOwnerLimitAvailable = async (tx, identity) => {
    const [row] = await tx`
      select count(*)::int as count
      from triggers
      where user_id = ${identity.ownerId}
        and deleted = false
    `;
    if ((row?.count ?? 0) >= maxScheduledTasksPerUser) {
      throw new BridgeError(
        'task_quota_exceeded',
        `Scheduled task limit reached (${maxScheduledTasksPerUser} tasks)`,
      );
    }
  };

  const assertLimitAvailable = async (tx, identity) => {
    const [row] = await tx`
      select count(*)::int as count
      from triggers
      where agent_id = ${identity.agentAccountId}
        and deleted = false
        and status in ('active', 'running')
    `;
    if ((row?.count ?? 0) >= MAX_ENABLED_TASKS_PER_AGENT) {
      throw new BridgeError(
        'agent_task_limit_exceeded',
        `This agent already has ${MAX_ENABLED_TASKS_PER_AGENT} enabled tasks; pause or delete one first`,
      );
    }
  };

  const assertRetainedLimitAvailable = async (tx, identity) => {
    const [row] = await tx`
      select count(*)::int as count
      from triggers
      where agent_id = ${identity.agentAccountId}
        and external_id like ${`${SELF_CRON_EXTERNAL_PREFIX}%`}
        and deleted = false
    `;
    if ((row?.count ?? 0) >= MAX_RETAINED_SELF_CRON_TASKS_PER_AGENT) {
      throw new BridgeError(
        'agent_task_retained_limit_exceeded',
        `This agent already has ${MAX_RETAINED_SELF_CRON_TASKS_PER_AGENT} retained self-created tasks; delete one first`,
      );
    }
  };

  return {
    async resolveIdentity(openclawId, sessionId) {
      const [row] = await sql`
        select a.account_id as agent_account_id, a.owner_id
        from agents a
        join accounts aa on aa.id = a.account_id and aa.deleted = false
        join accounts owner on owner.id = a.owner_id and owner.deleted = false
        join sessions s on s.id = ${sessionId}::uuid
          and s.owner_id = a.owner_id
          and s.gateway_session_key = 'eden3:s:' || s.id::text
          and s.deleted = false
        join session_agents sa on sa.session_id = s.id and sa.agent_account_id = a.account_id
        where a.openclaw_id = ${openclawId}
        limit 1
      `;
      return row ? { agentAccountId: row.agent_account_id, ownerId: row.owner_id } : null;
    },

    async list(identity) {
      const rows = await sql`
        select id, name, prompt, schedule, status, next_scheduled_run,
               last_run_time, last_error
        from triggers
        where user_id = ${identity.ownerId}
          and agent_id = ${identity.agentAccountId}
          and external_id like ${`${SELF_CRON_EXTERNAL_PREFIX}%`}
          and deleted = false
        order by created_at desc, id desc
        limit 200
      `;
      return rows.map(mapTask);
    },

    async create(identity, input) {
      return sql.begin(async (tx) => {
        await lockOwner(tx, identity);
        await assertOwnerLimitAvailable(tx, identity);
        await lockAgent(tx, identity);
        await assertLimitAvailable(tx, identity);
        await assertRetainedLimitAvailable(tx, identity);
        const [row] = await tx`
          insert into triggers (
            external_id, user_id, agent_id, name, prompt, schedule, status,
            session_target, next_scheduled_run, error_count
          ) values (
            ${`${SELF_CRON_EXTERNAL_PREFIX}${randomUUID()}`}, ${identity.ownerId},
            ${identity.agentAccountId}, ${input.name}, ${input.prompt},
            ${tx.json(JSON.stringify(input.schedule))}, 'active', 'new', ${input.nextScheduledRun.toISOString()}, 0
          )
          returning id, name, prompt, schedule, status, next_scheduled_run,
                    last_run_time, last_error
        `;
        return mapTask(row);
      });
    },

    async update(identity, id, patch, now) {
      return sql.begin(async (tx) => {
        // Match the /tasks route's lock order (agent advisory lock, then row)
        // so owner and agent edits cannot deadlock each other.
        await lockAgent(tx, identity);
        const row = await ownedTask(tx, identity, id, true);
        if (row.status === 'running') throw new BridgeError('task_running', 'A running task cannot be changed');
        const enabled = patch.enabled ?? row.status === 'active';
        if (enabled && row.status !== 'active') await assertLimitAvailable(tx, identity);
        const schedule = patch.schedule ?? row.schedule;
        const nextScheduledRun = enabled ? requireUpcoming(schedule, now) : null;
        const [updated] = await tx`
          update triggers
          set name = ${patch.name ?? row.name},
              prompt = ${patch.prompt ?? row.prompt},
              schedule = ${tx.json(JSON.stringify(schedule))},
              status = ${enabled ? 'active' : 'paused'},
              next_scheduled_run = ${nextScheduledRun?.toISOString() ?? null},
              updated_at = now()
          where id = ${id}
          returning id, name, prompt, schedule, status, next_scheduled_run,
                    last_run_time, last_error
        `;
        return mapTask(updated);
      });
    },

    async remove(identity, id) {
      return sql.begin(async (tx) => {
        await lockAgent(tx, identity);
        const row = await ownedTask(tx, identity, id, true);
        if (row.status === 'running') throw new BridgeError('task_running', 'A running task cannot be deleted');
        const [updated] = await tx`
          update triggers
          set deleted = true, status = 'finished', next_scheduled_run = null, updated_at = now()
          where id = ${id}
          returning id, name, prompt, schedule, status, next_scheduled_run,
                    last_run_time, last_error
        `;
        return mapTask(updated);
      });
    },
  };
}

export function createBridgeServer(dispatch) {
  return net.createServer((socket) => {
    socket.setTimeout(5_000, () => socket.destroy());
    const chunks = [];
    let bytes = 0;
    let handled = false;
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      if (handled) return;
      bytes += chunk.length;
      if (bytes > MAX_FRAME_BYTES) {
        handled = true;
        socket.destroy();
        return;
      }
      chunks.push(chunk);
      const frame = Buffer.concat(chunks);
      const newline = frame.indexOf(0x0a);
      if (newline === -1) return;
      if (frame.subarray(newline + 1).toString('utf8').trim()) {
        handled = true;
        socket.destroy();
        return;
      }
      handled = true;
      void (async () => {
        try {
          const result = await dispatch(JSON.parse(frame.subarray(0, newline).toString('utf8')));
          socket.end(`${JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ok: true, ...result })}\n`);
        } catch (error) {
          const known = error instanceof BridgeError;
          socket.end(`${JSON.stringify({
            protocolVersion: PROTOCOL_VERSION,
            ok: false,
            error: {
              code: known ? error.code : 'internal_error',
              message: known ? error.message : 'cron bridge request failed',
            },
          })}\n`);
        }
      })();
    });
  });
}

async function removeStaleSocket(socketPath) {
  try {
    const existing = await lstat(socketPath);
    if (!existing.isSocket()) throw new Error('cron bridge socket path occupied');
    await unlink(socketPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const apiDatabaseUrl = process.env.EDEN3_API_DATABASE_URL;
  const socketPath = process.env.AGENT_CRON_SOCKET_PATH || DEFAULT_SOCKET_PATH;
  if (!databaseUrl || !socketPath.startsWith('/')) throw new Error('cron bridge configuration invalid');
  assertMatchingDatabaseSelection(databaseUrl, apiDatabaseUrl);
  const maxScheduledTasksPerUser = parseScheduledTaskLimit(
    process.env.MAX_SCHEDULED_TASKS_PER_USER,
  );
  await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o770 });
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    await chown(path.dirname(socketPath), 1000, 1000);
    process.setgid(1000);
    process.setuid(1000);
  }
  const { default: postgres } = await import('postgres');
  const sql = postgres(databaseUrl, { max: 4, connect_timeout: 5, idle_timeout: 20, max_lifetime: 1800 });
  const store = createPostgresTaskStore(sql, { maxScheduledTasksPerUser });
  const dispatch = (request) => handleBridgeRequest(request, store);

  await removeStaleSocket(socketPath);
  const server = createBridgeServer(dispatch);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o660);
  process.stdout.write('agent cron bridge ready\n');

  const shutdown = async () => {
    await new Promise((resolve) => server.close(resolve));
    await sql.end({ timeout: 5 });
    try {
      await unlink(socketPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') process.exitCode = 1;
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => void shutdown().finally(() => process.exit()));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write('agent cron bridge failed\n');
    process.exit(1);
  });
}
