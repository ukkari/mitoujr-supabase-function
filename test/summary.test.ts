import { describe, expect, it } from "vitest";
import { currentTargetDate, targetRange } from "../src/summary";
import { workflowId } from "../src/routes/admin";

describe("summary scheduling", () => {
  it("uses a deterministic workflow id for the target JST date", () => {
    const now = new Date("2026-08-29T22:00:00.000Z");
    const targetDate = currentTargetDate("yesterday", now);
    expect(targetDate).toBe("2026-08-29");
    expect(workflowId(targetDate)).toBe("summary-2026-08-29");
  });

  it("collects the entire previous JST calendar day", () => {
    const range = targetRange("yesterday", "2026-08-29");
    expect(new Date(range.startTimeUtc).toISOString()).toBe("2026-08-28T15:00:00.000Z");
    expect(new Date(range.endTimeUtc).toISOString()).toBe("2026-08-29T15:00:00.000Z");
  });
});
