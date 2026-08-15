const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/;

function parseCalendarDateToUtcTimestamp(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }

  const matched = value.match(DATE_ONLY_PATTERN);
  if (!matched) {
    return null;
  }

  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
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

function getJstCalendarDateUtcTimestamp(now: Date): number {
  const nowInJst = new Date(now.getTime() + JST_OFFSET_MS);
  return Date.UTC(
    nowInJst.getUTCFullYear(),
    nowInJst.getUTCMonth(),
    nowInJst.getUTCDate(),
  );
}

export function calculateJstCalendarDayDifference(
  dueDate: unknown,
  now = new Date(),
): number | null {
  const dueDateTimestamp = parseCalendarDateToUtcTimestamp(dueDate);
  if (dueDateTimestamp === null || Number.isNaN(now.getTime())) {
    return null;
  }

  const todayTimestamp = getJstCalendarDateUtcTimestamp(now);
  return (dueDateTimestamp - todayTimestamp) / DAY_MS;
}
