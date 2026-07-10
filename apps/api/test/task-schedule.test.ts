import { describe, expect, it } from 'vitest';

import {
  isOneTimeSchedule,
  nextOccurrence,
  TaskScheduleError,
} from '../src/services/task-schedule';

/** Pure tests — no DB, no fake timers, all instants explicit. */

const iso = (value: string): Date => new Date(value);

describe('nextOccurrence — one-time {at}', () => {
  it('returns the instant while it is still in the future', () => {
    const at = '2026-07-11T15:00:00.000Z';
    expect(nextOccurrence({ at }, iso('2026-07-10T00:00:00Z'))?.toISOString()).toBe(at);
  });

  it('accepts offset timestamps and normalizes to the same instant', () => {
    const next = nextOccurrence(
      { at: '2026-07-11T17:00:00+02:00' },
      iso('2026-07-10T00:00:00Z'),
    );
    expect(next?.toISOString()).toBe('2026-07-11T15:00:00.000Z');
  });

  it('returns null once the instant has passed (or is exactly now)', () => {
    const at = '2026-07-10T00:00:00.000Z';
    expect(nextOccurrence({ at }, iso('2026-07-10T00:00:00Z'))).toBeNull();
    expect(nextOccurrence({ at }, iso('2026-07-10T00:00:01Z'))).toBeNull();
  });

  it('throws on unparsable at values', () => {
    expect(() => nextOccurrence({ at: 'tomorrow-ish' }, new Date())).toThrow(TaskScheduleError);
    expect(() => nextOccurrence({ at: 42 }, new Date())).toThrow(TaskScheduleError);
  });

  it('isOneTimeSchedule discriminates the shape', () => {
    expect(isOneTimeSchedule({ at: '2026-07-11T15:00:00Z' })).toBe(true);
    expect(isOneTimeSchedule({ hour: 9, minute: 0 })).toBe(false);
    expect(isOneTimeSchedule(null)).toBe(false);
  });
});

describe('nextOccurrence — daily', () => {
  const schedule = { hour: 9, minute: 30, timezone: 'UTC' };

  it('fires later today when the time is still ahead', () => {
    expect(nextOccurrence(schedule, iso('2026-07-10T08:00:00Z'))?.toISOString()).toBe(
      '2026-07-10T09:30:00.000Z',
    );
  });

  it('rolls to tomorrow once the time has passed', () => {
    expect(nextOccurrence(schedule, iso('2026-07-10T10:00:00Z'))?.toISOString()).toBe(
      '2026-07-11T09:30:00.000Z',
    );
  });

  it('is strictly after `from` (a fire at 09:30 stamps tomorrow 09:30)', () => {
    expect(nextOccurrence(schedule, iso('2026-07-10T09:30:00Z'))?.toISOString()).toBe(
      '2026-07-11T09:30:00.000Z',
    );
    // …but a sub-minute `from` still catches the upcoming boundary.
    expect(nextOccurrence(schedule, iso('2026-07-10T09:29:59.500Z'))?.toISOString()).toBe(
      '2026-07-10T09:30:00.000Z',
    );
  });

  it('defaults to UTC when timezone is missing or empty', () => {
    expect(
      nextOccurrence({ hour: 9, minute: 30 }, iso('2026-07-10T08:00:00Z'))?.toISOString(),
    ).toBe('2026-07-10T09:30:00.000Z');
    expect(
      nextOccurrence({ hour: 9, minute: 30, timezone: '' }, iso('2026-07-10T08:00:00Z'))?.toISOString(),
    ).toBe('2026-07-10T09:30:00.000Z');
  });
});

describe('nextOccurrence — weekly day_of_week (APScheduler 0=Mon)', () => {
  // 2026-07-10 is a FRIDAY.
  const friday = iso('2026-07-10T12:00:00Z');

  it('maps aps 0 to Monday', () => {
    const next = nextOccurrence({ hour: 8, minute: 0, day_of_week: 0, timezone: 'UTC' }, friday);
    expect(next?.toISOString()).toBe('2026-07-13T08:00:00.000Z');
    expect(next?.getUTCDay()).toBe(1); // JS Monday
  });

  it('maps aps 6 to Sunday', () => {
    const next = nextOccurrence({ hour: 8, minute: 0, day_of_week: 6, timezone: 'UTC' }, friday);
    expect(next?.toISOString()).toBe('2026-07-12T08:00:00.000Z');
    expect(next?.getUTCDay()).toBe(0); // JS Sunday
  });

  it('fires the same day when the weekly slot is still ahead', () => {
    // aps 4 = Friday.
    const next = nextOccurrence({ hour: 15, minute: 0, day_of_week: 4, timezone: 'UTC' }, friday);
    expect(next?.toISOString()).toBe('2026-07-10T15:00:00.000Z');
  });

  it('accepts day names and name ranges', () => {
    const next = nextOccurrence(
      { hour: 8, minute: 0, day_of_week: 'sat', timezone: 'UTC' },
      friday,
    );
    expect(next?.toISOString()).toBe('2026-07-11T08:00:00.000Z');

    const weekdayNext = nextOccurrence(
      { hour: 8, minute: 0, day_of_week: 'mon-fri', timezone: 'UTC' },
      iso('2026-07-10T09:00:00Z'), // Friday, past 08:00 → Monday
    );
    expect(weekdayNext?.toISOString()).toBe('2026-07-13T08:00:00.000Z');
  });

  it('handles aps weekend ranges that wrap in cron numbering (5-6 = Sat,Sun)', () => {
    const next = nextOccurrence(
      { hour: 8, minute: 0, day_of_week: '5-6', timezone: 'UTC' },
      friday,
    );
    expect(next?.toISOString()).toBe('2026-07-11T08:00:00.000Z'); // Saturday
  });

  it('supports aps number lists', () => {
    // aps 0,2 = Mon,Wed; from Friday → Monday.
    const next = nextOccurrence(
      { hour: 8, minute: 0, day_of_week: '0,2', timezone: 'UTC' },
      friday,
    );
    expect(next?.getUTCDay()).toBe(1);
  });
});

describe('nextOccurrence — hourly and cron-ish fields', () => {
  it('hour "*" fires every hour at the given minute', () => {
    const schedule = { hour: '*', minute: 15, timezone: 'UTC' };
    expect(nextOccurrence(schedule, iso('2026-07-10T10:20:00Z'))?.toISOString()).toBe(
      '2026-07-10T11:15:00.000Z',
    );
    expect(nextOccurrence(schedule, iso('2026-07-10T10:10:00Z'))?.toISOString()).toBe(
      '2026-07-10T10:15:00.000Z',
    );
  });

  it('supports minute lists and hour ranges', () => {
    const schedule = { hour: '9-17', minute: '0,30', timezone: 'UTC' };
    expect(nextOccurrence(schedule, iso('2026-07-10T09:05:00Z'))?.toISOString()).toBe(
      '2026-07-10T09:30:00.000Z',
    );
    expect(nextOccurrence(schedule, iso('2026-07-10T17:45:00Z'))?.toISOString()).toBe(
      '2026-07-11T09:00:00.000Z',
    );
  });

  it('supports step values', () => {
    const schedule = { hour: '*', minute: '*/15', timezone: 'UTC' };
    expect(nextOccurrence(schedule, iso('2026-07-10T10:16:00Z'))?.toISOString()).toBe(
      '2026-07-10T10:30:00.000Z',
    );
  });

  it('supports day-of-month and month restrictions', () => {
    const xmas = { month: 12, day: 25, hour: 0, minute: 0, timezone: 'UTC' };
    expect(nextOccurrence(xmas, iso('2026-07-10T00:00:00Z'))?.toISOString()).toBe(
      '2026-12-25T00:00:00.000Z',
    );
  });

  it('uses cron OR semantics when both day and day_of_week are restricted', () => {
    // day=20 OR Monday (aps 0); from Friday 2026-07-10 → Monday 07-13 wins.
    const next = nextOccurrence(
      { day: 20, day_of_week: 0, hour: 8, minute: 0, timezone: 'UTC' },
      iso('2026-07-10T12:00:00Z'),
    );
    expect(next?.toISOString()).toBe('2026-07-13T08:00:00.000Z');
  });
});

describe('nextOccurrence — timezones and DST', () => {
  it('evaluates wall-clock time in the schedule timezone', () => {
    // 09:00 America/New_York in July = 13:00Z (EDT).
    const next = nextOccurrence(
      { hour: 9, minute: 0, timezone: 'America/New_York' },
      iso('2026-07-10T00:00:00Z'),
    );
    expect(next?.toISOString()).toBe('2026-07-10T13:00:00.000Z');
  });

  it('differs from the same wall-clock schedule in UTC', () => {
    const utc = nextOccurrence({ hour: 9, minute: 0, timezone: 'UTC' }, iso('2026-07-10T00:00:00Z'));
    expect(utc?.toISOString()).toBe('2026-07-10T09:00:00.000Z');
  });

  it('skips the nonexistent spring-forward hour without crashing', () => {
    // US DST 2026: clocks jump 02:00→03:00 on Sun 2026-03-08 (07:00Z).
    // A 02:30 New York schedule cannot fire that day; the next valid
    // occurrence is Monday 02:30 EDT = 06:30Z.
    const next = nextOccurrence(
      { hour: 2, minute: 30, timezone: 'America/New_York' },
      iso('2026-03-08T05:00:00Z'), // Sunday 00:00 EST
    );
    expect(next?.toISOString()).toBe('2026-03-09T06:30:00.000Z');
  });

  it('fires at the first of the repeated fall-back instants', () => {
    // US DST end 2026: clocks repeat 01:00-02:00 on Sun 2026-11-01.
    // 01:30 EDT (05:30Z) is the first wall-clock match.
    const next = nextOccurrence(
      { hour: 1, minute: 30, timezone: 'America/New_York' },
      iso('2026-11-01T04:00:00Z'), // Sunday 00:00 EDT
    );
    expect(next?.toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });
});

describe('nextOccurrence — scan cap and validation', () => {
  it('returns null when no occurrence exists within the cap', () => {
    // Feb 30 never exists.
    expect(
      nextOccurrence({ month: 2, day: 30, hour: 0, minute: 0 }, iso('2026-07-10T00:00:00Z')),
    ).toBeNull();
  });

  it('finds leap-day occurrences inside the cap, none beyond it', () => {
    const leap = { month: 2, day: 29, hour: 0, minute: 0, timezone: 'UTC' };
    // 2027-06-01 → 2028-02-29 is ~273 days: found.
    expect(nextOccurrence(leap, iso('2027-06-01T00:00:00Z'))?.toISOString()).toBe(
      '2028-02-29T00:00:00.000Z',
    );
    // 2026-07-10 → 2028-02-29 is ~600 days: beyond the 400-day cap.
    expect(nextOccurrence(leap, iso('2026-07-10T00:00:00Z'))).toBeNull();
  });

  it('requires hour and minute', () => {
    expect(() => nextOccurrence({ minute: 5 }, new Date())).toThrow(/hour is required/);
    expect(() => nextOccurrence({ hour: 5 }, new Date())).toThrow(/minute is required/);
  });

  it('rejects out-of-range and malformed fields', () => {
    expect(() => nextOccurrence({ hour: 99, minute: 0 }, new Date())).toThrow(TaskScheduleError);
    expect(() => nextOccurrence({ hour: 9, minute: 'sixty' }, new Date())).toThrow(
      TaskScheduleError,
    );
    expect(() => nextOccurrence({ hour: 9, minute: 0, day: 32 }, new Date())).toThrow(
      TaskScheduleError,
    );
    expect(() => nextOccurrence({ hour: 9, minute: 0, day_of_week: 7 }, new Date())).toThrow(
      TaskScheduleError,
    );
    expect(() => nextOccurrence({ hour: '5-2', minute: 0 }, new Date())).toThrow(
      TaskScheduleError,
    );
    expect(() => nextOccurrence('daily', new Date())).toThrow(TaskScheduleError);
    expect(() => nextOccurrence(null, new Date())).toThrow(TaskScheduleError);
  });

  it('rejects unknown timezones', () => {
    expect(() =>
      nextOccurrence({ hour: 9, minute: 0, timezone: 'Mars/Olympus_Mons' }, new Date()),
    ).toThrow(TaskScheduleError);
  });
});
