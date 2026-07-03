/**
 * Schedule helpers for the tasks surface. Pure functions, no React.
 *
 * Triggers store eden1's APScheduler-style cron dict (snake_case, see
 * `cronScheduleDto` in @eden3/shared). Two directions:
 *   - describeSchedule(): render any stored dict as a human line
 *     ("Weekly on Monday at 9:30 AM · UTC").
 *   - the modal builds new dicts from daily/weekly + HH:MM + timezone,
 *     sending day_of_week as an APScheduler/cron day name ("mon") so the
 *     0=Monday vs 0=Sunday ambiguity never enters the wire format.
 */

import type { CronSchedule } from "@/lib/types";

export const WEEKDAYS = [
  { value: "mon", label: "Monday" },
  { value: "tue", label: "Tuesday" },
  { value: "wed", label: "Wednesday" },
  { value: "thu", label: "Thursday" },
  { value: "fri", label: "Friday" },
  { value: "sat", label: "Saturday" },
  { value: "sun", label: "Sunday" },
] as const;

function asInt(value: number | string | undefined): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return null;
}

/**
 * Label a day_of_week value. Numbers use the APScheduler convention
 * (0 = Monday); names ("mon", "monday") map to full labels; anything more
 * exotic (ranges, lists) passes through verbatim.
 */
export function weekdayLabel(value: number | string): string {
  const index = asInt(value);
  if (index != null && index >= 0 && index <= 6) {
    return WEEKDAYS[index]?.label ?? String(value);
  }
  if (typeof value === "string") {
    const key = value.trim().toLowerCase();
    const exact = WEEKDAYS.find(
      (day) => key === day.value || key === day.label.toLowerCase(),
    );
    return exact?.label ?? value;
  }
  return String(value);
}

/** "9:30 AM" — matches the en-US formatting used everywhere else. */
export function formatClock(hour: number, minute: number): string {
  const h = ((hour % 24) + 24) % 24;
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve}:${String(minute).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/**
 * Human-readable line for a stored cron dict. Handles the shapes this UI
 * creates (daily/weekly at HH:MM) plus common migrated ones; anything else
 * degrades to a compact `key=value` dump instead of lying.
 */
export function describeSchedule(
  schedule: CronSchedule | null | undefined,
): string {
  if (!schedule || typeof schedule !== "object") return "No schedule";

  const hour = asInt(schedule.hour);
  const minute = asInt(schedule.minute);
  const clock = hour != null ? formatClock(hour, minute ?? 0) : null;
  const at = clock ? ` at ${clock}` : "";
  const tz = schedule.timezone ? ` · ${schedule.timezone}` : "";

  if (schedule.day_of_week !== undefined) {
    return `Weekly on ${weekdayLabel(schedule.day_of_week)}${at}${tz}`;
  }
  if (schedule.day !== undefined) {
    return `Monthly on day ${String(schedule.day)}${at}${tz}`;
  }
  if (clock) return `Daily${at}${tz}`;
  if (minute != null) return `Hourly at :${String(minute).padStart(2, "0")}${tz}`;

  const parts = Object.entries(schedule)
    .filter(([key, value]) => value !== undefined && key !== "timezone")
    .map(([key, value]) => `${key}=${String(value)}`);
  return parts.length > 0 ? `${parts.join(" ")}${tz}` : `Unscheduled${tz}`;
}

/** The browser's IANA timezone, with a safe fallback. */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const FALLBACK_TIMEZONES = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Europe/Kyiv",
  "Africa/Lagos",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Bangkok",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Sydney",
  "Pacific/Auckland",
];

/**
 * Timezone options for the schedule builder: UTC + the current zone pinned
 * on top, then the full IANA list (or a curated fallback where
 * Intl.supportedValuesOf is unavailable).
 */
export function timezoneOptions(current: string): string[] {
  let zones: string[] = FALLBACK_TIMEZONES;
  try {
    if (typeof Intl.supportedValuesOf === "function") {
      zones = Intl.supportedValuesOf("timeZone");
    }
  } catch {
    /* keep fallback */
  }
  return [...new Set(["UTC", current, ...zones].filter(Boolean))];
}

/** Parse an `<input type="time">` value; null when unparsable. */
export function parseClock(
  value: string,
): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  if (!match) return null;
  const hour = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}
