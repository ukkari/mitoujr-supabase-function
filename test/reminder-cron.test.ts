import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { runReminderCron } from "../src/reminder-cron";

const env = {
  ADMIN_TRIGGER_SECRET: "admin-secret",
  DRY_RUN: "false",
} as Env;

function reminder(overrides: Record<string, unknown> = {}) {
  return {
    postId: "abcdefghijklmnopqrstuvwxyz",
    channelId: "channel",
    dueDate: "2026-09-01",
    content: "body",
    targetUsernamesJson: '["alice"]',
    completed: false,
    createdAt: null,
    updatedAt: "2026-08-30T00:00:00.000Z",
    legacyRowJson: null,
    ...overrides,
  };
}

function dependencies(item = reminder()) {
  const repository = {
    listIncomplete: vi.fn().mockResolvedValue([item]),
    markCompleted: vi.fn().mockResolvedValue(undefined),
    claimDelivery: vi.fn().mockResolvedValue({
      claimed: true,
      claimToken: "claim",
      pendingPostId: "cf:pending",
    }),
    markDeliverySent: vi.fn().mockResolvedValue(undefined),
    markDeliveryFailed: vi.fn().mockResolvedValue(undefined),
  };
  const mattermost = {
    getMentors: vi.fn().mockResolvedValue([{ id: "mentor-id", username: "mentor" }]),
    getPost: vi.fn().mockResolvedValue({
      post: { id: item.postId, channel_id: item.channelId, user_id: "author", message: "root", create_at: 0 },
      notFound: false,
    }),
    getThreadPostIds: vi.fn().mockResolvedValue([item.postId]),
    getReactions: vi.fn().mockResolvedValue([]),
    getUsersByUsernames: vi.fn().mockResolvedValue([{ id: "alice-id", username: "alice" }]),
    postReply: vi.fn().mockResolvedValue({ id: "reply-id" }),
  };
  return { repository, mattermost };
}

describe("reminder cron", () => {
  it("completes a reminder whose Mattermost post was deleted", async () => {
    const deps = dependencies();
    deps.mattermost.getPost.mockResolvedValue({ post: null, notFound: true });
    const result = await runReminderCron(env, new Date("2026-08-31T15:00:00Z"), deps as never);
    expect(result.completed).toBe(1);
    expect(deps.repository.markCompleted).toHaveBeenCalledOnce();
    expect(deps.mattermost.postReply).not.toHaveBeenCalled();
  });

  it.each(["done", "white_check_mark", "heavy_check_mark"])(
    "treats :%s: as completion",
    async (emoji) => {
      const deps = dependencies();
      deps.mattermost.getReactions.mockResolvedValue([{ user_id: "alice-id", emoji_name: emoji }]);
      const result = await runReminderCron(env, new Date("2026-08-31T15:00:00Z"), deps as never);
      expect(result.completed).toBe(1);
      expect(deps.repository.markCompleted).toHaveBeenCalledOnce();
    },
  );

  it("keeps an unknown target in the reminder and records delivery", async () => {
    const deps = dependencies(reminder({ targetUsernamesJson: '["ghost"]' }));
    deps.mattermost.getUsersByUsernames.mockResolvedValue([]);
    const result = await runReminderCron(env, new Date("2026-08-31T15:00:00Z"), deps as never);
    expect(result.sent).toBe(1);
    expect(deps.mattermost.postReply).toHaveBeenCalledWith(
      "channel",
      "abcdefghijklmnopqrstuvwxyz",
      expect.stringContaining("@ghost"),
      "cf:pending",
    );
    expect(deps.repository.markDeliverySent).toHaveBeenCalledWith(
      "abcdefghijklmnopqrstuvwxyz",
      "2026-09-01",
      "claim",
      "reply-id",
    );
  });

  it("does not post when another run already claimed the JST delivery day", async () => {
    const deps = dependencies();
    deps.repository.claimDelivery.mockResolvedValue({
      claimed: false,
      claimToken: "other",
      pendingPostId: "cf:other",
    });
    const result = await runReminderCron(env, new Date("2026-08-31T15:00:00Z"), deps as never);
    expect(result.skippedDuplicate).toBe(1);
    expect(deps.mattermost.postReply).not.toHaveBeenCalled();
  });

  it("surfaces a Turso outage before any Mattermost operation", async () => {
    const deps = dependencies();
    deps.repository.listIncomplete.mockRejectedValue(new Error("database unavailable"));
    await expect(runReminderCron(env, new Date(), deps as never)).rejects.toThrow(
      "database unavailable",
    );
    expect(deps.mattermost.getMentors).not.toHaveBeenCalled();
  });
});
