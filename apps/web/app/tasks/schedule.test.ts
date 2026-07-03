import { describe, expect, it } from "vitest";
import {
  describeSchedule,
  formatClock,
  parseClock,
  timezoneOptions,
  weekdayLabel,
} from "./schedule";

describe("describeSchedule", () => {
  it("renders daily schedules", () => {
    expect(
      describeSchedule({ hour: 9, minute: 30, timezone: "America/Los_Angeles" }),
    ).toBe("Daily at 9:30 AM · America/Los_Angeles");
    expect(describeSchedule({ hour: 0, minute: 0 })).toBe("Daily at 12:00 AM");
    expect(describeSchedule({ hour: 18, minute: 5, timezone: "UTC" })).toBe(
      "Daily at 6:05 PM · UTC",
    );
  });

  it("renders weekly schedules from day names and APScheduler indexes", () => {
    expect(
      describeSchedule({ day_of_week: "mon", hour: 18, minute: 0, timezone: "UTC" }),
    ).toBe("Weekly on Monday at 6:00 PM · UTC");
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
      "hour=*/2 · UTC",
    );
  });

  it("handles null/empty schedules", () => {
    expect(describeSchedule(null)).toBe("No schedule");
    expect(describeSchedule(undefined)).toBe("No schedule");
    expect(describeSchedule({})).toBe("Unscheduled");
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

describe("timezoneOptions", () => {
  it("pins UTC and the current zone first, deduped", () => {
    const zones = timezoneOptions("America/Los_Angeles");
    expect(zones[0]).toBe("UTC");
    expect(zones[1]).toBe("America/Los_Angeles");
    expect(zones.filter((z) => z === "America/Los_Angeles")).toHaveLength(1);
    expect(zones.filter((z) => z === "UTC")).toHaveLength(1);
  });
});
