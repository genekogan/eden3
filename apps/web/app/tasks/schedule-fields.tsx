"use client";

/**
 * Shared cadence builder for the new-task and edit-task modals.
 *
 * Four cadences map onto the two wire shapes:
 *   once   → {at: ISO instant}            (datetime-local, browser tz)
 *   hourly → {hour: "*", minute, timezone}
 *   daily  → {hour, minute, timezone}
 *   weekly → {hour, minute, day_of_week: "mon", timezone}
 */

import type { CronSchedule, TaskScheduleInput } from "@/lib/types";
import {
  browserTimezone,
  parseClock,
  parseDatetimeLocal,
  toDatetimeLocalValue,
  WEEKDAYS,
} from "./schedule";

export type Cadence = "once" | "hourly" | "daily" | "weekly";

export interface ScheduleFormState {
  cadence: Cadence;
  /** `<input type="datetime-local">` value (once). */
  onceAt: string;
  /** Minute of the hour, "0".."59" (hourly). */
  minute: string;
  /** APScheduler/cron day name (weekly). */
  weekday: string;
  /** "HH:MM" (daily/weekly). */
  time: string;
  timezone: string;
}

export function defaultScheduleForm(): ScheduleFormState {
  return {
    cadence: "daily",
    // Suggest one hour out so "Once" starts valid.
    onceAt: toDatetimeLocalValue(new Date(Date.now() + 60 * 60 * 1000)),
    minute: "0",
    weekday: "mon",
    time: "09:00",
    timezone: browserTimezone(),
  };
}

/** Prefill the form from a stored schedule (edit modal). */
export function formFromSchedule(
  schedule: CronSchedule | null | undefined,
): ScheduleFormState {
  const form = defaultScheduleForm();
  const record =
    schedule && typeof schedule === "object"
      ? (schedule as Record<string, unknown>)
      : {};

  if (typeof record.at === "string") {
    const ms = Date.parse(record.at);
    return {
      ...form,
      cadence: "once",
      onceAt: Number.isFinite(ms) ? toDatetimeLocalValue(new Date(ms)) : form.onceAt,
    };
  }

  const asIntOr = (value: unknown, fallback: number): number => {
    if (typeof value === "number" && Number.isInteger(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value.trim())) {
      return Number.parseInt(value.trim(), 10);
    }
    return fallback;
  };
  const minute = asIntOr(record.minute, 0);
  const timezone =
    typeof record.timezone === "string" && record.timezone !== ""
      ? record.timezone
      : form.timezone;

  if (record.hour === "*") {
    return { ...form, cadence: "hourly", minute: String(minute), timezone };
  }

  const hour = asIntOr(record.hour, 9);
  const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const dayOfWeek = record.day_of_week;
  return {
    ...form,
    cadence: dayOfWeek === undefined ? "daily" : "weekly",
    weekday: typeof dayOfWeek === "string" ? dayOfWeek : form.weekday,
    time,
    timezone,
  };
}

/**
 * Wire schedule for the current form, or null while invalid (unparsable
 * time, hourly minute out of range, one-time instant not in the future).
 */
export function scheduleFromForm(form: ScheduleFormState): TaskScheduleInput | null {
  if (form.cadence === "once") {
    const at = parseDatetimeLocal(form.onceAt);
    if (at === null || Date.parse(at) <= Date.now()) return null;
    return { at };
  }
  if (form.cadence === "hourly") {
    const minute = /^\d{1,2}$/.test(form.minute.trim())
      ? Number.parseInt(form.minute.trim(), 10)
      : NaN;
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
    return { hour: "*", minute, timezone: form.timezone };
  }
  const clock = parseClock(form.time);
  if (!clock) return null;
  return {
    hour: clock.hour,
    minute: clock.minute,
    timezone: form.timezone,
    ...(form.cadence === "weekly" ? { day_of_week: form.weekday } : {}),
  };
}

const FIELD_INPUT =
  "w-full rounded-lg border border-edge bg-background px-3 py-2 text-sm text-foreground placeholder:text-faint focus:border-accent/60 focus:outline-none";

const CADENCES: Cadence[] = ["once", "hourly", "daily", "weekly"];

export function ScheduleFields({
  form,
  onChange,
}: {
  form: ScheduleFormState;
  onChange: (next: ScheduleFormState) => void;
}) {
  const set = (patch: Partial<ScheduleFormState>) => onChange({ ...form, ...patch });

  return (
    <div className="space-y-2.5">
      <div className="inline-flex rounded-lg border border-edge bg-background p-0.5">
        {CADENCES.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => set({ cadence: option })}
            aria-pressed={form.cadence === option}
            className={`rounded-md px-3 py-1.5 text-xs capitalize transition-colors ${
              form.cadence === option
                ? "bg-accent/15 text-accent-soft"
                : "text-muted hover:text-foreground"
            }`}
          >
            {option}
          </button>
        ))}
      </div>

      {form.cadence === "once" ? (
        <input
          type="datetime-local"
          value={form.onceAt}
          onChange={(event) => set({ onceAt: event.target.value })}
          aria-label="Run at"
          required
          className={`${FIELD_INPUT} w-auto`}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2.5">
          {form.cadence === "hourly" ? (
            <label className="flex items-center gap-2 text-xs text-muted">
              at minute
              <input
                type="number"
                min={0}
                max={59}
                value={form.minute}
                onChange={(event) => set({ minute: event.target.value })}
                aria-label="Minute of the hour"
                required
                className={`${FIELD_INPUT} w-20`}
              />
            </label>
          ) : null}
          {form.cadence === "weekly" ? (
            <select
              value={form.weekday}
              onChange={(event) => set({ weekday: event.target.value })}
              aria-label="Day of week"
              className={`${FIELD_INPUT} w-auto flex-1`}
            >
              {WEEKDAYS.map((day) => (
                <option key={day.value} value={day.value}>
                  {day.label}
                </option>
              ))}
            </select>
          ) : null}
          {form.cadence === "daily" || form.cadence === "weekly" ? (
            <input
              type="time"
              value={form.time}
              onChange={(event) => set({ time: event.target.value })}
              aria-label="Time of day"
              required
              className={`${FIELD_INPUT} w-32`}
            />
          ) : null}
        </div>
      )}
      <p className="text-[11px] text-faint">Times follow your system clock.</p>
    </div>
  );
}
