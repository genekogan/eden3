import { apschedulerDowToCron, CronSyncError } from '@eden3/gateway';

/**
 * Pure next-run computation for scheduled tasks (triggers) — no DB, no clock.
 *
 * Two schedule shapes live in `triggers.schedule` jsonb:
 *
 *   1. Recurring — the eden1/APScheduler dict (snake_case): {minute, hour,
 *      day?, month?, day_of_week?, timezone?}. minute/hour are REQUIRED and
 *      may be numbers or cron-ish strings ("*", "1,15", "2-5", "*\/15" —
 *      the same field grammar `scheduleToCron` in @eden3/gateway accepts).
 *      `day_of_week` uses the APScheduler convention (0=Mon … 6=Sun) or day
 *      names; when BOTH day and day_of_week are restricted, standard-cron OR
 *      semantics apply (fire when either matches).
 *   2. One-time — {at: <ISO-8601 instant>}: exactly that instant, and null
 *      once it has passed.
 *
 * `nextOccurrence` evaluates candidates in the schedule's IANA timezone via
 * Intl and scans forward from `from`, capped at {@link SCAN_CAP_DAYS} days
 * (null past the cap). The scan is wall-clock based, so DST oddities resolve
 * naturally: a 02:30 schedule on a spring-forward day (02:30 never exists)
 * simply matches the next day's 02:30.
 */

export class TaskScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskScheduleError';
  }
}

/** One-time schedule shape: fire once at this instant. */
export interface OneTimeSchedule {
  at: string;
}

export function isOneTimeSchedule(schedule: unknown): schedule is OneTimeSchedule {
  return (
    typeof schedule === 'object' &&
    schedule !== null &&
    !Array.isArray(schedule) &&
    'at' in (schedule as Record<string, unknown>)
  );
}

/** Give up scanning for a recurring match this far past `from`. */
export const SCAN_CAP_DAYS = 400;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Field parsing — cron-ish values ("*", 7, "1,15", "2-5", "*/10") to sets
// ---------------------------------------------------------------------------

/**
 * Parse one schedule field into the set of matching values, or null for
 * unrestricted ("*"). Grammar mirrors `scheduleToCron`'s field validation:
 * comma-separated items, each `*`, `n`, or `a-b`, optionally `/step`.
 */
function parseField(
  value: unknown,
  name: string,
  min: number,
  max: number,
  required: boolean,
): Set<number> | null {
  if (value === undefined || value === null) {
    if (required) throw new TaskScheduleError(`schedule.${name} is required`);
    return null;
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new TaskScheduleError(`schedule.${name} ${value} out of range ${min}-${max}`);
    }
    return new Set([value]);
  }
  if (typeof value !== 'string') {
    throw new TaskScheduleError(`schedule.${name} must be a number or string`);
  }
  const text = value.trim();
  if (text === '*') return null;
  if (text === '' || !/^[0-9*/,-]+$/.test(text)) {
    throw new TaskScheduleError(`schedule.${name} "${value}" is not a valid cron field`);
  }
  const out = new Set<number>();
  for (const item of text.split(',')) {
    addFieldItem(out, item, name, min, max, false);
  }
  return out;
}

/** Parse one comma-separated item (`*`, `n`, `a-b`, each with optional `/step`). */
function addFieldItem(
  out: Set<number>,
  item: string,
  name: string,
  min: number,
  max: number,
  allowWrap: boolean,
): void {
  const bad = (): never => {
    throw new TaskScheduleError(`schedule.${name} has an invalid part "${item}"`);
  };
  const [baseRaw, stepRaw, ...rest] = item.split('/');
  if (rest.length > 0 || baseRaw === undefined || baseRaw === '') bad();
  let step = 1;
  if (stepRaw !== undefined) {
    step = Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) bad();
  }
  let lo: number;
  let hi: number;
  if (baseRaw === '*') {
    lo = min;
    hi = max;
  } else if (baseRaw!.includes('-')) {
    const [a, b, ...more] = baseRaw!.split('-');
    if (more.length > 0) bad();
    lo = Number(a);
    hi = Number(b);
  } else {
    lo = Number(baseRaw);
    hi = lo;
    if (stepRaw !== undefined) hi = max; // cron "n/step" = n..max by step
  }
  if (!Number.isInteger(lo) || !Number.isInteger(hi)) bad();
  if (lo < min || lo > max || hi < min || hi > max) {
    throw new TaskScheduleError(`schedule.${name} "${item}" has out-of-range part`);
  }
  if (lo <= hi) {
    for (let v = lo; v <= hi; v += step) out.add(v);
  } else if (allowWrap) {
    // Wrapped range (day-of-week only, e.g. "6-0" = Sat,Sun).
    for (let v = lo; v <= max; v += step) out.add(v);
    for (let v = min; v <= hi; v += step) out.add(v);
  } else {
    bad();
  }
}

const DAY_NAME_INDEX: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/**
 * Parse `day_of_week` into a set of JS weekday numbers (0=Sun … 6=Sat) or
 * null for unrestricted. Input uses the APScheduler convention (0=Mon) or day
 * names; `apschedulerDowToCron` normalizes to the cron dialect first, so this
 * stays byte-compatible with what the old gateway-cron path accepted.
 */
function parseDayOfWeek(value: unknown): Set<number> | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new TaskScheduleError('schedule.day_of_week must be a number or string');
  }
  let cronDow: string;
  try {
    cronDow = apschedulerDowToCron(value);
  } catch (err) {
    if (err instanceof CronSyncError) throw new TaskScheduleError(err.message);
    throw err;
  }
  if (cronDow === '*') return null;
  const out = new Set<number>();
  for (const item of cronDow.split(',')) {
    // Name tokens ("mon", "mon-fri") → digits, then the shared item parser.
    const digits = item.replace(/[a-z]+/g, (nameToken) => {
      const idx = DAY_NAME_INDEX[nameToken];
      if (idx === undefined) {
        throw new TaskScheduleError(`schedule.day_of_week has an invalid part "${item}"`);
      }
      return String(idx);
    });
    // Digit-wise APScheduler→cron remapping can produce wrapped ranges
    // (aps "5-6" Sat-Sun → cron "6-0"), so wrapping is allowed here.
    addFieldItem(out, digits, 'day_of_week', 0, 6, true);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Timezone-aware wall-clock parts
// ---------------------------------------------------------------------------

interface LocalParts {
  minute: number;
  hour: number;
  day: number;
  month: number;
  /** JS convention: 0=Sun … 6=Sat. */
  dow: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timezone);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    });
  } catch {
    throw new TaskScheduleError(`schedule.timezone "${timezone}" is not a valid IANA timezone`);
  }
  formatterCache.set(timezone, formatter);
  return formatter;
}

function localParts(formatter: Intl.DateTimeFormat, date: Date): LocalParts {
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of formatter.formatToParts(date)) parts[part.type] = part.value;
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour) % 24, // guard: some ICU builds render 24:00
    day: Number(parts.day),
    month: Number(parts.month),
    dow: WEEKDAY_INDEX[parts.weekday ?? ''] ?? 0,
  };
}

// ---------------------------------------------------------------------------
// nextOccurrence
// ---------------------------------------------------------------------------

function oneTimeNext(schedule: OneTimeSchedule, from: Date): Date | null {
  if (typeof schedule.at !== 'string') {
    throw new TaskScheduleError('schedule.at must be an ISO-8601 string');
  }
  const ms = Date.parse(schedule.at);
  if (!Number.isFinite(ms)) {
    throw new TaskScheduleError(`schedule.at "${schedule.at}" is not a valid ISO-8601 instant`);
  }
  return ms > from.getTime() ? new Date(ms) : null;
}

/**
 * The next instant this schedule fires strictly after `from`, or null when
 * there is none (one-time already passed, or no recurring match within
 * {@link SCAN_CAP_DAYS} days). Throws {@link TaskScheduleError} on malformed
 * schedules (missing/invalid fields, unknown timezone, unparsable `at`).
 */
export function nextOccurrence(schedule: unknown, from: Date): Date | null {
  if (typeof schedule !== 'object' || schedule === null || Array.isArray(schedule)) {
    throw new TaskScheduleError('schedule must be an object');
  }
  if (isOneTimeSchedule(schedule)) return oneTimeNext(schedule, from);

  const dict = schedule as Record<string, unknown>;
  const minuteSet = parseField(dict.minute, 'minute', 0, 59, true);
  const hourSet = parseField(dict.hour, 'hour', 0, 23, true);
  const daySet = parseField(dict.day, 'day', 1, 31, false);
  const monthSet = parseField(dict.month, 'month', 1, 12, false);
  const dowSet = parseDayOfWeek(dict.day_of_week);
  const timezone =
    typeof dict.timezone === 'string' && dict.timezone !== '' ? dict.timezone : 'UTC';
  const formatter = formatterFor(timezone);

  const matches = (set: Set<number> | null, value: number): boolean =>
    set === null || set.has(value);
  // Standard-cron semantics: when BOTH day-of-month and day-of-week are
  // restricted, the date matches when EITHER does.
  const dateMatches = (p: LocalParts): boolean => {
    if (!matches(monthSet, p.month)) return false;
    if (daySet !== null && dowSet !== null) return daySet.has(p.day) || dowSet.has(p.dow);
    return matches(daySet, p.day) && matches(dowSet, p.dow);
  };

  // First whole minute at-or-after `from` (sub-minute precision is not part
  // of the schedule grammar).
  let t = Math.ceil(from.getTime() / MINUTE_MS) * MINUTE_MS;
  if (t === from.getTime()) t += MINUTE_MS; // strictly after `from`
  const cap = from.getTime() + SCAN_CAP_DAYS * DAY_MS;

  while (t <= cap) {
    const p = localParts(formatter, new Date(t));
    if (!dateMatches(p) || !matches(hourSet, p.hour)) {
      // Jump to the next local hour boundary — safe because no minute within
      // a non-matching local hour/date can match, and all modern IANA offsets
      // are whole minutes.
      t += (60 - p.minute) * MINUTE_MS;
      continue;
    }
    if (matches(minuteSet, p.minute)) return new Date(t);
    t += MINUTE_MS;
  }
  return null;
}
