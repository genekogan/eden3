/**
 * Dependency-free mirror of apps/api/src/services/task-schedule.ts for the
 * credential-isolated cron bridge container. Parity tests cover one-time,
 * cron-field, APScheduler weekday, timezone, and DST behavior.
 */

export class TaskScheduleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TaskScheduleError';
  }
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
export const SCAN_CAP_DAYS = 400;

function plainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function addFieldItem(out, item, name, min, max, allowWrap = false) {
  const bad = () => {
    throw new TaskScheduleError(`schedule.${name} has an invalid part "${item}"`);
  };
  const [baseRaw, stepRaw, ...rest] = item.split('/');
  if (rest.length > 0 || !baseRaw) bad();
  let step = 1;
  if (stepRaw !== undefined) {
    step = Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) bad();
  }
  let lo;
  let hi;
  if (baseRaw === '*') {
    lo = min;
    hi = max;
  } else if (baseRaw.includes('-')) {
    const [a, b, ...more] = baseRaw.split('-');
    if (more.length > 0) bad();
    lo = Number(a);
    hi = Number(b);
  } else {
    lo = Number(baseRaw);
    hi = stepRaw === undefined ? lo : max;
  }
  if (!Number.isInteger(lo) || !Number.isInteger(hi)) bad();
  if (lo < min || lo > max || hi < min || hi > max) {
    throw new TaskScheduleError(`schedule.${name} "${item}" has out-of-range part`);
  }
  if (lo <= hi) {
    for (let value = lo; value <= hi; value += step) out.add(value);
  } else if (allowWrap) {
    for (let value = lo; value <= max; value += step) out.add(value);
    for (let value = min; value <= hi; value += step) out.add(value);
  } else {
    bad();
  }
}

function parseField(value, name, min, max, required) {
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
  if (!text || !/^[0-9*/,-]+$/.test(text)) {
    throw new TaskScheduleError(`schedule.${name} "${value}" is not a valid cron field`);
  }
  const out = new Set();
  for (const item of text.split(',')) addFieldItem(out, item, name, min, max);
  return out;
}

const DAY_NAME_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const DOW_NAME_RE = /^(mon|tue|wed|thu|fri|sat|sun)([,-](mon|tue|wed|thu|fri|sat|sun))*$/;

function apschedulerDowToCron(value) {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value > 6) {
      throw new TaskScheduleError(`invalid day_of_week ${value} — apscheduler expects 0 (Mon) … 6 (Sun)`);
    }
    return String((value + 1) % 7);
  }
  if (typeof value !== 'string') {
    throw new TaskScheduleError('schedule.day_of_week must be a number or string');
  }
  const text = value.trim().toLowerCase();
  if (text === '*' || DOW_NAME_RE.test(text)) return text;
  if (!/^[0-6]([,-][0-6])*$/.test(text)) {
    throw new TaskScheduleError(
      `unsupported day_of_week "${value}" — expected "*", 0-6 (apscheduler, 0=Mon), lists/ranges, or day names`,
    );
  }
  return text.replace(/[0-6]/g, (digit) => String((Number(digit) + 1) % 7));
}

function parseDayOfWeek(value) {
  if (value === undefined || value === null) return null;
  const cron = apschedulerDowToCron(value);
  if (cron === '*') return null;
  const out = new Set();
  for (const item of cron.split(',')) {
    const digits = item.replace(/[a-z]+/g, (token) => {
      const index = DAY_NAME_INDEX[token];
      if (index === undefined) {
        throw new TaskScheduleError(`schedule.day_of_week has an invalid part "${item}"`);
      }
      return String(index);
    });
    addFieldItem(out, digits, 'day_of_week', 0, 6, true);
  }
  return out;
}

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatterCache = new Map();

function formatterFor(timezone) {
  const cached = formatterCache.get(timezone);
  if (cached) return cached;
  let formatter;
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

function localParts(formatter, date) {
  const values = {};
  for (const part of formatter.formatToParts(date)) values[part.type] = part.value;
  return {
    minute: Number(values.minute),
    hour: Number(values.hour) % 24,
    day: Number(values.day),
    month: Number(values.month),
    dow: WEEKDAY_INDEX[values.weekday] ?? 0,
  };
}

/** Validate a schedule even when a paused one-time instant is already past. */
export function validateSchedule(schedule) {
  if (!plainObject(schedule)) throw new TaskScheduleError('schedule must be an object');
  if (Object.hasOwn(schedule, 'at')) {
    if (Object.keys(schedule).some((key) => key !== 'at')) {
      throw new TaskScheduleError('a schedule is either recurring (hour/minute) or one-time (at), not both');
    }
    if (typeof schedule.at !== 'string' || !Number.isFinite(Date.parse(schedule.at))) {
      throw new TaskScheduleError(`schedule.at "${schedule.at}" is not a valid ISO-8601 instant`);
    }
    return;
  }
  parseField(schedule.minute, 'minute', 0, 59, true);
  parseField(schedule.hour, 'hour', 0, 23, true);
  parseField(schedule.day, 'day', 1, 31, false);
  parseField(schedule.month, 'month', 1, 12, false);
  parseDayOfWeek(schedule.day_of_week);
  const timezone = typeof schedule.timezone === 'string' && schedule.timezone ? schedule.timezone : 'UTC';
  formatterFor(timezone);
}

/** Return the first occurrence strictly after `from`, matching the API. */
export function nextOccurrence(schedule, from) {
  validateSchedule(schedule);
  if (Object.hasOwn(schedule, 'at')) {
    const value = Date.parse(schedule.at);
    return value > from.getTime() ? new Date(value) : null;
  }

  const minuteSet = parseField(schedule.minute, 'minute', 0, 59, true);
  const hourSet = parseField(schedule.hour, 'hour', 0, 23, true);
  const daySet = parseField(schedule.day, 'day', 1, 31, false);
  const monthSet = parseField(schedule.month, 'month', 1, 12, false);
  const dowSet = parseDayOfWeek(schedule.day_of_week);
  const timezone = typeof schedule.timezone === 'string' && schedule.timezone ? schedule.timezone : 'UTC';
  const formatter = formatterFor(timezone);
  const matches = (set, value) => set === null || set.has(value);
  const dateMatches = (parts) => {
    if (!matches(monthSet, parts.month)) return false;
    if (daySet !== null && dowSet !== null) return daySet.has(parts.day) || dowSet.has(parts.dow);
    return matches(daySet, parts.day) && matches(dowSet, parts.dow);
  };

  let timestamp = Math.ceil(from.getTime() / MINUTE_MS) * MINUTE_MS;
  if (timestamp === from.getTime()) timestamp += MINUTE_MS;
  const cap = from.getTime() + SCAN_CAP_DAYS * DAY_MS;
  while (timestamp <= cap) {
    const parts = localParts(formatter, new Date(timestamp));
    if (!dateMatches(parts) || !matches(hourSet, parts.hour)) {
      timestamp += (60 - parts.minute) * MINUTE_MS;
      continue;
    }
    if (matches(minuteSet, parts.minute)) return new Date(timestamp);
    timestamp += MINUTE_MS;
  }
  return null;
}
