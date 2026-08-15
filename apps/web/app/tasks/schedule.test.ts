import { describe, expect, it } from "vitest";
import {
  describeSchedule,
  formatClock,
  parseClock,
  parseDatetimeLocal,
  toDatetimeLocalValue,
  weekdayLabel,
} from "./schedule";
import { formFromSchedule, scheduleFromForm } from "./schedule-fields";

describe("describeSchedule", () => {
  it("renders daily schedules", () => {
    expect(
      describeSchedule({ hour: 9, minute: 30, timezone: "America/Los_Angeles" }),
    ).toBe("Daily at 9:30 AM");
    expect(describeSchedule({ hour: 0, minute: 0 })).toBe("Daily at 12:00 AM");
    expect(describeSchedule({ hour: 18, minute: 5, timezone: "UTC" })).toBe(
      "Daily at 6:05 PM",
    );
  });

  it("renders weekly schedules from day names and APScheduler indexes", () => {
    expect(
      describeSchedule({ day_of_week: "mon", hour: 18, minute: 0, timezone: "UTC" }),
    ).toBe("Weekly on Monday at 6:00 PM");
    // APScheduler numeric convention: 0 = Monday, 4 = Friday.
    expect(describeSchedule({ day_of_week: 4, hour: 3, minute: 0 })).toBe(
      "Weekly on Friday at 3:00 AM",
    );
    expect(describeSchedule({ day_of_week: "0", hour: 8, minute: 15 })).toBe(
      "Weekly on Monday at 8:15 AM",
    );
  });

  it("passes exotic day_of_week strings through verbatim", () => {
    expect(describeSchedule({ day_of_week: "mon-fri", hour: 9, minute: 0 })).toBe(
      "Weekly on mon-fri at 9:00 AM",
    );
  });

  it("renders monthly, hourly, and string-hour fallbacks", () => {
    expect(describeSchedule({ day: 1, hour: 7, minute: 0 })).toBe(
      "Monthly on day 1 at 7:00 AM",
    );
    expect(describeSchedule({ minute: 15 })).toBe("Hourly at :15");
    // Non-numeric hour degrades to the key=value dump instead of lying.
    expect(describeSchedule({ hour: "*/2", timezone: "UTC" })).toBe(
      "hour=*/2",
    );
  });

  it("handles null/empty schedules", () => {
    expect(describeSchedule(null)).toBe("No schedule");
    expect(describeSchedule(undefined)).toBe("No schedule");
    expect(describeSchedule({})).toBe("Unscheduled");
  });

  it("renders one-time {at} schedules in the viewer's locale", () => {
    const at = "2026-07-11T15:00:00.000Z";
    const rendered = describeSchedule({ at });
    expect(rendered).toMatch(/^Once on /);
    expect(rendered).toContain("2026");
    expect(describeSchedule({ at: "garbage" })).toBe("Once (invalid time)");
  });

  it("renders hourly schedules (hour '*')", () => {
    expect(describeSchedule({ hour: "*", minute: 15, timezone: "UTC" })).toBe(
      "Hourly at :15",
    );
  });
});

describe("datetime-local helpers", () => {
  it("round-trips instants through the input value format", () => {
    const instant = new Date(2026, 6, 11, 15, 30); // local wall clock
    const value = toDatetimeLocalValue(instant);
    expect(value).toBe("2026-07-11T15:30");
    expect(parseDatetimeLocal(value)).toBe(instant.toISOString());
  });

  it("rejects unparsable values", () => {
    expect(parseDatetimeLocal("")).toBeNull();
    expect(parseDatetimeLocal("tomorrow")).toBeNull();
  });
});

describe("scheduleFromForm / formFromSchedule", () => {
  const base = {
    cadence: "daily" as const,
    onceAt: "2099-01-01T09:00",
    minute: "0",
    weekday: "mon",
    time: "09:30",
    timezone: "UTC",
  };

  it("builds daily and weekly dicts", () => {
    expect(scheduleFromForm(base)).toEqual({ hour: 9, minute: 30, timezone: "UTC" });
    expect(
      scheduleFromForm({ ...base, cadence: "weekly", weekday: "fri" }),
    ).toEqual({
      hour: 9,
      minute: 30,
      day_of_week: "fri",
      timezone: "UTC",
    });
  });

  it("builds hourly dicts with hour '*' and validates the minute", () => {
    expect(scheduleFromForm({ ...base, cadence: "hourly", minute: "45" })).toEqual({
      hour: "*",
      minute: 45,
      timezone: "UTC",
    });
    expect(scheduleFromForm({ ...base, cadence: "hourly", minute: "61" })).toBeNull();
    expect(scheduleFromForm({ ...base, cadence: "hourly", minute: "x" })).toBeNull();
  });

  it("builds one-time {at} schedules and rejects past instants", () => {
    const future = scheduleFromForm({ ...base, cadence: "once" });
    expect(future).toEqual({ at: parseDatetimeLocal(base.onceAt) });
    expect(
      scheduleFromForm({ ...base, cadence: "once", onceAt: "2001-01-01T00:00" }),
    ).toBeNull();
  });

  it("prefills the form from every stored shape", () => {
    expect(formFromSchedule({ hour: 14, minute: 5, timezone: "UTC" })).toMatchObject({
      cadence: "daily",
      time: "14:05",
      timezone: "UTC",
    });
    expect(
      formFromSchedule({ hour: 9, minute: 0, day_of_week: "fri", timezone: "UTC" }),
    ).toMatchObject({ cadence: "weekly", weekday: "fri", time: "09:00" });
    expect(formFromSchedule({ hour: "*", minute: 45, timezone: "UTC" })).toMatchObject({
      cadence: "hourly",
      minute: "45",
    });
    const at = "2026-07-11T15:00:00.000Z";
    const onceForm = formFromSchedule({ at });
    expect(onceForm.cadence).toBe("once");
    expect(parseDatetimeLocal(onceForm.onceAt)).toBe(at);
  });
});

describe("weekdayLabel", () => {
  it("maps numbers (0=Monday), short names, and long names", () => {
    expect(weekdayLabel(0)).toBe("Monday");
    expect(weekdayLabel(6)).toBe("Sunday");
    expect(weekdayLabel("tue")).toBe("Tuesday");
    expect(weekdayLabel("Saturday")).toBe("Saturday");
    expect(weekdayLabel(9)).toBe("9");
  });
});

describe("formatClock / parseClock", () => {
  it("round-trips time input values", () => {
    expect(parseClock("09:00")).toEqual({ hour: 9, minute: 0 });
    expect(parseClock("23:59")).toEqual({ hour: 23, minute: 59 });
    expect(parseClock("7:05")).toEqual({ hour: 7, minute: 5 });
    expect(parseClock("24:00")).toBeNull();
    expect(parseClock("")).toBeNull();
    expect(parseClock("nope")).toBeNull();
  });

  it("formats 12-hour clocks", () => {
    expect(formatClock(0, 0)).toBe("12:00 AM");
    expect(formatClock(12, 0)).toBe("12:00 PM");
    expect(formatClock(15, 4)).toBe("3:04 PM");
  });
});
