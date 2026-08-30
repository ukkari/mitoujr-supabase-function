import { describe, expect, it } from "vitest";
import {
  normalizeUsernames,
  parseReminderContent,
  reminderMessage,
  shouldSendReminder,
} from "../src/domain/reminder";

describe("reminder domain", () => {
  it("parses new and legacy targeted reminders", () => {
    expect(parseReminderContent("body", '["alice","@bob"]')).toEqual({
      body: "body",
      targetUsernames: ["alice", "bob"],
    });
    expect(parseReminderContent(JSON.stringify({
      body: "legacy body",
      target_usernames: ["alice"],
    }))).toEqual({ body: "legacy body", targetUsernames: ["alice"] });
    expect(parseReminderContent("mentor body")).toEqual({
      body: "mentor body",
      targetUsernames: null,
    });
  });

  it("normalizes and deduplicates usernames", () => {
    expect(normalizeUsernames(["@alice", "alice", " bob ", ""])).toEqual([
      "alice",
      "bob",
    ]);
  });

  it("uses the established reminder schedule", () => {
    expect([8, 7, 6, 5, 3, 2, 1, 0, -1].map(shouldSendReminder)).toEqual([
      false,
      true,
      false,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it("formats deadline and overdue messages", () => {
    expect(reminderMessage("2026-09-01", 0, ["@alice"])).toContain("今日は締切日");
    expect(reminderMessage("2026-09-01", -2, ["@alice"])).toContain("2日過ぎています");
  });
});
