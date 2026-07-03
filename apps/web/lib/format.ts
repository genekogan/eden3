/**
 * Presentation formatters shared across surfaces. Pure functions, no React.
 *
 * All number/date formatting pins the "en-US" locale so server-rendered HTML
 * matches client hydration regardless of the host machine's locale.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function toEpochMs(value: string | number | Date): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return new Date(value).getTime();
}

const monthDay = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});
const monthDayYear = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const dateTime = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** "Jun 12" (same year) or "Jun 12, 2025". */
export function formatDate(
  value: string | number | Date,
  now: string | number | Date = Date.now(),
): string {
  const time = toEpochMs(value);
  if (!Number.isFinite(time)) return "—";
  const date = new Date(time);
  const sameYear = date.getFullYear() === new Date(toEpochMs(now)).getFullYear();
  return (sameYear ? monthDay : monthDayYear).format(date);
}

/** "Jun 12, 2026, 3:04 PM" — permalink pages, transaction rows. */
export function formatDateTime(value: string | number | Date): string {
  const time = toEpochMs(value);
  if (!Number.isFinite(time)) return "—";
  return dateTime.format(new Date(time));
}

/**
 * Compact relative time: "just now", "4m ago", "3h ago", "2d ago", then a
 * calendar date. Future timestamps (task next-run) read "in 4m" / "in 3h".
 */
export function formatRelativeTime(
  value: string | number | Date,
  now: string | number | Date = Date.now(),
): string {
  const time = toEpochMs(value);
  if (!Number.isFinite(time)) return "—";
  const delta = toEpochMs(now) - time; // > 0 = past
  const abs = Math.abs(delta);
  const wrap = (text: string) => (delta >= 0 ? `${text} ago` : `in ${text}`);

  if (abs < 45_000) return delta >= 0 ? "just now" : "in <1m";
  if (abs < 45 * MINUTE) return wrap(`${Math.max(1, Math.round(abs / MINUTE))}m`);
  if (abs < 22 * HOUR) return wrap(`${Math.round(abs / HOUR)}h`);
  if (abs < 26 * DAY) return wrap(`${Math.round(abs / DAY)}d`);
  return formatDate(time, now);
}

function trimFixed(value: number, digits: number): string {
  return value
    .toFixed(digits)
    .replace(/\.0+$/, "")
    .replace(/(\.\d*?)0+$/, "$1");
}

const mannaSmall = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const mannaWhole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const mannaExactFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 4,
});

/**
 * Compact manna amount for chips and rows: "842", "1,204", "12.4k", "3.1M".
 * Sign is preserved (transaction amounts are negative for debits).
 */
export function formatManna(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${trimFixed(value / 1_000_000, 1)}M`;
  if (abs >= 10_000) return `${trimFixed(value / 1_000, 1)}k`;
  if (abs >= 10 || Number.isInteger(value)) return mannaWhole.format(value);
  return mannaSmall.format(value);
}

/** Full-precision manna with separators — tooltips and the manna page. */
export function formatMannaExact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return mannaExactFormat.format(value);
}
