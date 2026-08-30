import { describe, expect, it } from "vitest";
import {
  calculateJstCalendarDayDifference,
  jstDate,
  parseSlashDate,
  summaryTimeRange,
} from "../src/domain/date";

describe("JST calendar dates", () => {
  it("strictly parses slash-command dates", () => {
    expect(parseSlashDate("2026/08/30")).toBe("2026-08-30");
    expect(parseSlashDate("2026/02/29")).toBeNull();
    expect(parseSlashDate("2026-08-30")).toBeNull();
    expect(parseSlashDate("2026/13/01")).toBeNull();
  });

  it("calculates before, on, and after the deadline by JST date", () => {
    expect(calculateJstCalendarDayDifference(
      "2026-06-21",
      new Date("2026-06-14T15:00:00.000Z"),
    )).toBe(6);
    expect(calculateJstCalendarDayDifference(
      "2026-06-21",
      new Date("2026-06-20T15:00:00.000Z"),
    )).toBe(0);
    expect(calculateJstCalendarDayDifference(
      "2026-06-21",
      new Date("2026-06-21T15:00:00.000Z"),
    )).toBe(-1);
  });

  it("switches the date exactly at JST midnight", () => {
    expect(jstDate(new Date("2026-08-29T14:59:59.999Z"))).toBe("2026-08-29");
    expect(jstDate(new Date("2026-08-29T15:00:00.000Z"))).toBe("2026-08-30");
  });

  it("uses the previous complete JST day for a 07:00 summary", () => {
    const range = summaryTimeRange("yesterday", new Date("2026-08-29T22:00:00.000Z"));
    expect(range.targetDateJst).toBe("2026-08-29");
    expect(new Date(range.startTimeUtc).toISOString()).toBe("2026-08-28T15:00:00.000Z");
    expect(new Date(range.endTimeUtc).toISOString()).toBe("2026-08-29T15:00:00.000Z");
  });
});
