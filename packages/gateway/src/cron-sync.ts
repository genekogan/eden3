import { z } from 'zod';

import {
  OpenClawCli,
  type CliExecOptions,
  type OpenClawCliLike,
  type OpenClawCliResult,
} from './docker';

/**
 * Sync eden3 triggers onto OpenClaw cron jobs.
 *
 * Cron management is CLI-only (spike probe #9: HTTP `/tools/invoke` correctly
 * denies cron) and the cron CLI talks to the gateway WS, so every command runs
 * with `gatewayToken: true` (see docker.ts). NOTE the gateway ALSO gates these
 * write ops on the paired CLI device having the `operator.admin` scope —
 * a pending scope-upgrade request must be approved once per gateway install
 * (`openclaw devices list` → `openclaw devices approve <requestId>`).
 *
 * Idempotence: jobs are named `eden3:<triggerId>` and reconciled against
 * `cron list --json` — matching job → no-op; drifted job → remove + re-add;
 * `enabled: false` → remove. `cron rm` takes the job ID (not the name), so the
 * list diff also resolves name → id.
 */

export class CronSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronSyncError';
  }
}

// ---------------------------------------------------------------------------
// eden schedule dict → cron expression
// ---------------------------------------------------------------------------

/**
 * Eden legacy schedule dict (mongo `triggers2.schedule`), produced for Python
 * apscheduler's CronTrigger. Observed live keys: hour, minute, second, day,
 * month, year, day_of_week ("*" | "0".."6"), start_date, end_date, timezone.
 * Values are numbers or strings ("*" and cron-style lists/ranges allowed).
 */
export interface EdenSchedule {
  minute?: number | string;
  hour?: number | string;
  day?: number | string;
  month?: number | string;
  /** APSCHEDULER convention: 0 = MONDAY … 6 = Sunday (NOT cron's 0=Sunday). */
  day_of_week?: number | string;
  /** IANA timezone, e.g. "America/New_York". */
  timezone?: string;
  /** Tolerated-but-ignored keys (second, year, start_date, end_date, …). */
  [key: string]: unknown;
}

const DOW_NAME_RE = /^(mon|tue|wed|thu|fri|sat|sun)([,-](mon|tue|wed|thu|fri|sat|sun))*$/;

/**
 * Convert an apscheduler `day_of_week` value to standard-cron semantics.
 * apscheduler numbers weekdays 0=Monday…6=Sunday; cron uses 0=Sunday…6=Saturday
 * — so every standalone digit d maps to (d + 1) % 7. `"*"` and day-name
 * strings (valid in both dialects) pass through unchanged.
 */
export function apschedulerDowToCron(dow: number | string): string {
  if (typeof dow === 'number') {
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) {
      throw new CronSyncError(`invalid day_of_week ${dow} — apscheduler expects 0 (Mon) … 6 (Sun)`);
    }
    return String((dow + 1) % 7);
  }
  const text = dow.trim().toLowerCase();
  if (text === '*') return '*';
  if (DOW_NAME_RE.test(text)) return text; // mon,tue,… valid in cron as-is
  if (!/^[0-6]([,-][0-6])*$/.test(text)) {
    throw new CronSyncError(
      `unsupported day_of_week "${dow}" — expected "*", 0-6 (apscheduler, 0=Mon), lists/ranges, or day names`,
    );
  }
  return text.replace(/[0-6]/g, (d) => String((Number(d) + 1) % 7));
}

function fieldToCron(
  value: number | string | undefined,
  name: string,
  min: number,
  max: number,
  required: boolean,
): string {
  if (value === undefined) {
    if (required) throw new CronSyncError(`schedule.${name} is required`);
    return '*';
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new CronSyncError(`schedule.${name} ${value} out of range ${min}-${max}`);
    }
    return String(value);
  }
  const text = value.trim();
  if (text === '*') return '*';
  if (!/^[0-9*/,-]+$/.test(text) || text === '') {
    throw new CronSyncError(`schedule.${name} "${value}" is not a valid cron field`);
  }
  for (const token of text.split(/[,/-]/)) {
    if (token === '' || token === '*') continue;
    const n = Number(token);
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new CronSyncError(`schedule.${name} "${value}" has out-of-range part "${token}"`);
    }
  }
  return text;
}

/**
 * Convert an eden schedule dict to a 5-field cron expression + IANA tz.
 * `hour` and `minute` are required (every live eden trigger has them);
 * `second`, `year`, `start_date`, `end_date` are ignored — one-shot semantics
 * are the trigger scheduler's concern, not the recurring cron line's.
 */
export function scheduleToCron(schedule: EdenSchedule): { cron: string; tz?: string } {
  const minute = fieldToCron(schedule.minute, 'minute', 0, 59, true);
  const hour = fieldToCron(schedule.hour, 'hour', 0, 23, true);
  const dom = fieldToCron(schedule.day, 'day', 1, 31, false);
  const month = fieldToCron(schedule.month, 'month', 1, 12, false);
  const dow = schedule.day_of_week === undefined ? '*' : apschedulerDowToCron(schedule.day_of_week);
  const cron = `${minute} ${hour} ${dom} ${month} ${dow}`;
  return schedule.timezone !== undefined && schedule.timezone !== ''
    ? { cron, tz: schedule.timezone }
    : { cron };
}

// ---------------------------------------------------------------------------
// cron job reconciliation
// ---------------------------------------------------------------------------

const CRON_NAME_PREFIX = 'eden3:';

/** Gateway job name for an eden3 trigger (idempotence key). */
export function cronJobName(triggerId: string): string {
  if (!/^\S+$/.test(triggerId)) {
    throw new CronSyncError(`invalid triggerId "${triggerId}"`);
  }
  return `${CRON_NAME_PREFIX}${triggerId}`;
}

/** Lenient `cron list --json` schemas — unknown fields pass through. */
const cronJobSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    disabled: z.boolean().optional(),
  })
  .passthrough();
export type CronJob = z.infer<typeof cronJobSchema>;

const cronListSchema = z.object({ jobs: z.array(cronJobSchema).optional() }).passthrough();

export interface SyncTriggerParams {
  /** eden3 trigger id (uuid) — becomes job name `eden3:<triggerId>`. */
  triggerId: string;
  /** Gateway agent that runs the prompt. */
  openclawAgentId: string;
  /** 5-field cron expression (see {@link scheduleToCron}). */
  cronExpr: string;
  /** IANA timezone for the cron expression. */
  tz?: string;
  /** Agent message payload delivered on each run. */
  prompt: string;
  /** false → the gateway job is removed. */
  enabled: boolean;
}

export interface SyncTriggerResult {
  name: string;
  action: 'created' | 'replaced' | 'unchanged' | 'removed' | 'absent';
  /** Gateway job id (persist to triggers.openclawJobId). */
  jobId?: string;
}

export class CronSync {
  private readonly cli: OpenClawCliLike;
  private readonly configReadRetryAttempts: number;
  private readonly configReadRetryDelayMs: number;

  constructor(
    options: {
      cli?: OpenClawCliLike;
      configReadRetryAttempts?: number;
      configReadRetryDelayMs?: number;
    } = {},
  ) {
    this.cli = options.cli ?? new OpenClawCli();
    this.configReadRetryAttempts = options.configReadRetryAttempts ?? 4;
    this.configReadRetryDelayMs = options.configReadRetryDelayMs ?? 250;
  }

  /** All gateway cron jobs (any owner). */
  async listJobs(): Promise<CronJob[]> {
    const raw = await this.execJsonWithConfigRetry<unknown>(['cron', 'list'], {
      gatewayToken: true,
    });
    const parsed = cronListSchema.safeParse(raw);
    if (!parsed.success) throw new CronSyncError('cron list --json returned an unexpected shape');
    return parsed.data.jobs ?? [];
  }

  /** Jobs owned by eden3 (name-prefixed). */
  async listEdenJobs(): Promise<CronJob[]> {
    return (await this.listJobs()).filter((job) => job.name?.startsWith(CRON_NAME_PREFIX) === true);
  }

  /**
   * Reconcile one trigger against the gateway:
   *   enabled + absent            → add            ("created")
   *   enabled + present, matching → no-op          ("unchanged")
   *   enabled + present, drifted  → rm all + add   ("replaced")
   *   disabled + present          → rm all         ("removed")
   *   disabled + absent           → no-op          ("absent")
   * Duplicate same-named jobs (crash between rm and add) are all removed
   * before re-adding, so the sync converges.
   */
  async syncTrigger(params: SyncTriggerParams): Promise<SyncTriggerResult> {
    const name = cronJobName(params.triggerId);
    const existing = (await this.listJobs()).filter((job) => job.name === name);

    if (!params.enabled) {
      for (const job of existing) await this.removeJob(job.id);
      return { name, action: existing.length > 0 ? 'removed' : 'absent' };
    }

    const [only] = existing;
    if (existing.length === 1 && only !== undefined && this.jobMatches(only, params)) {
      return { name, action: 'unchanged', jobId: only.id };
    }
    for (const job of existing) await this.removeJob(job.id);
    const jobId = await this.addJob(name, params);
    return {
      name,
      action: existing.length > 0 ? 'replaced' : 'created',
      ...(jobId !== undefined ? { jobId } : {}),
    };
  }

  /** Remove a gateway cron job by trigger id (no-op when absent). */
  async removeTrigger(triggerId: string): Promise<SyncTriggerResult> {
    const params: SyncTriggerParams = {
      triggerId,
      openclawAgentId: '',
      cronExpr: '',
      prompt: '',
      enabled: false,
    };
    return this.syncTrigger(params);
  }

  private async addJob(name: string, params: SyncTriggerParams): Promise<string | undefined> {
    const args = [
      'cron',
      'add',
      '--name',
      name,
      '--agent',
      params.openclawAgentId,
      '--cron',
      params.cronExpr,
      '--message',
      params.prompt,
      // Headless platform use: results reach eden3 via sessions_history sync,
      // not via channel delivery, so disable the runner's fallback delivery.
      '--no-deliver',
    ];
    if (params.tz !== undefined && params.tz !== '') args.push('--tz', params.tz);
    const raw = await this.execJsonWithConfigRetry<unknown>(args, { gatewayToken: true });
    return extractJobId(raw);
  }

  private async removeJob(jobId: string): Promise<void> {
    // exec (not execJson): rm output is informational; success = exit 0.
    await this.execWithConfigRetry(['cron', 'rm', jobId, '--json'], { gatewayToken: true });
  }

  private async execJsonWithConfigRetry<T>(
    args: readonly string[],
    options: CliExecOptions,
  ): Promise<T> {
    return this.withConfigReadRetry(() => this.cli.execJson<T>(args, options));
  }

  private async execWithConfigRetry(
    args: readonly string[],
    options: CliExecOptions,
  ): Promise<OpenClawCliResult> {
    return this.withConfigReadRetry(() => this.cli.exec(args, options));
  }

  private async withConfigReadRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.configReadRetryAttempts; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (!isTransientConfigReadError(err) || attempt >= this.configReadRetryAttempts) {
          throw err;
        }
        await sleep(this.configReadRetryDelayMs);
      }
    }
    throw lastError;
  }

  /**
   * Best-effort field comparison against an existing job. The exact
   * `cron list --json` job shape varies by payload kind, so fields are read
   * defensively — ANY unreadable/unequal desired field counts as drift, which
   * safely degrades to remove + re-add (idempotent).
   */
  private jobMatches(job: CronJob, params: SyncTriggerParams): boolean {
    if (job.enabled === false || job.disabled === true) return false;
    const record = job as Record<string, unknown>;
    const schedule = asRecord(record.schedule);
    const payload = asRecord(record.payload);

    const cron = firstString(record.cron, schedule?.expr, schedule?.cron, record.schedule);
    if (cron !== params.cronExpr) return false;

    if (params.tz !== undefined && params.tz !== '') {
      const tz = firstString(record.tz, record.timezone, schedule?.tz, schedule?.timezone);
      if (tz !== params.tz) return false;
    }

    const message = firstString(record.message, payload?.message, payload?.text);
    if (message !== params.prompt) return false;

    const agent = firstString(record.agentId, record.agent, payload?.agentId, payload?.agent);
    if (agent !== params.openclawAgentId) return false;

    return true;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function isTransientConfigReadError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    /Failed to read config/i.test(message) &&
    (/openclaw\.json/i.test(message) || /JSON5: invalid end of input/i.test(message))
  );
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractJobId(raw: unknown): string | undefined {
  const root = asRecord(raw);
  if (root === undefined) return undefined;
  const job = asRecord(root.job);
  return firstString(root.id, root.jobId, job?.id);
}
