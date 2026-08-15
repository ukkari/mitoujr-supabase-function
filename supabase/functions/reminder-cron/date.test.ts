import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { calculateJstCalendarDayDifference } from "./date.ts";

Deno.test("calculates reminder days using JST calendar dates", () => {
  const dueDate = "2026-06-21";

  assertEquals(
    calculateJstCalendarDayDifference(
      dueDate,
      new Date("2026-06-15T00:00:00+09:00"),
    ),
    6,
  );
  assertEquals(
    calculateJstCalendarDayDifference(
      dueDate,
      new Date("2026-06-21T00:00:00+09:00"),
    ),
    0,
  );
  assertEquals(
    calculateJstCalendarDayDifference(
      dueDate,
      new Date("2026-06-22T00:00:00+09:00"),
    ),
    -1,
  );
});

Deno.test("switches the remaining day count exactly at JST midnight", () => {
  const dueDate = "2026-06-21";

  assertEquals(
    calculateJstCalendarDayDifference(
      dueDate,
      new Date("2026-06-14T14:59:59Z"),
    ),
    7,
  );
  assertEquals(
    calculateJstCalendarDayDifference(
      dueDate,
      new Date("2026-06-14T15:00:00Z"),
    ),
    6,
  );
});

Deno.test("accepts database timestamps and rejects invalid calendar dates", () => {
  assertEquals(
    calculateJstCalendarDayDifference(
      "2026-06-21T00:00:00+00:00",
      new Date("2026-06-21T12:00:00+09:00"),
    ),
    0,
  );
  assertEquals(calculateJstCalendarDayDifference("2026-02-30"), null);
  assertEquals(calculateJstCalendarDayDifference(null), null);
  assertEquals(calculateJstCalendarDayDifference("not-a-date"), null);
});
