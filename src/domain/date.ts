const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/;
const SLASH_DATE_PATTERN = /^(\d{4})\/(\d{2})\/(\d{2})$/;

function validatedUtcDate(year: number, month: number, day: number): number | null {
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return timestamp;
}

export function parseSlashDate(value: string): string | null {
  const matched = value.match(SLASH_DATE_PATTERN);
  if (!matched) return null;
  const timestamp = validatedUtcDate(
    Number(matched[1]),
    Number(matched[2]),
    Number(matched[3]),
  );
  if (timestamp === null) return null;
  return new Date(timestamp).toISOString().slice(0, 10);
}

function parseCalendarDate(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const matched = value.match(ISO_DATE_PATTERN);
  if (!matched) return null;
  return validatedUtcDate(
    Number(matched[1]),
    Number(matched[2]),
    Number(matched[3]),
  );
}

export function jstDate(now = new Date()): string {
  const shifted = new Date(now.getTime() + JST_OFFSET_MS);
  return shifted.toISOString().slice(0, 10);
}

export function addCalendarDays(isoDate: string, days: number): string {
  const timestamp = parseCalendarDate(isoDate);
  if (timestamp === null) throw new Error(`Invalid calendar date: ${isoDate}`);
  return new Date(timestamp + days * DAY_MS).toISOString().slice(0, 10);
}

export function calculateJstCalendarDayDifference(
  dueDate: unknown,
  now = new Date(),
): number | null {
  const due = parseCalendarDate(dueDate);
  const today = parseCalendarDate(jstDate(now));
  if (due === null || today === null || Number.isNaN(now.getTime())) return null;
  return (due - today) / DAY_MS;
}

export function summaryTimeRange(
  target: "yesterday" | "today",
  now = new Date(),
): {
  startTimeUtc: number;
  endTimeUtc: number;
  targetDateJst: string;
  label: "昨日" | "今日";
} {
  const today = jstDate(now);
  const targetDateJst = target === "yesterday" ? addCalendarDays(today, -1) : today;
  const startTimeUtc = Date.parse(`${targetDateJst}T00:00:00+09:00`);
  const endTimeUtc = target === "yesterday"
    ? Date.parse(`${today}T00:00:00+09:00`)
    : now.getTime();
  return {
    startTimeUtc,
    endTimeUtc,
    targetDateJst,
    label: target === "yesterday" ? "昨日" : "今日",
  };
}
