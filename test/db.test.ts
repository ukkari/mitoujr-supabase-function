import { createClient } from "@libsql/client";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ReminderRepository } from "../src/db";

async function repository() {
  const client = createClient({ url: "file::memory:" });
  for (const migration of [
    "0001_initial.sql",
    "0002_summary_runs.sql",
    "0003_summary_fragments.sql",
    "0004_delivery_pending_post_id.sql",
  ]) {
    await client.executeMultiple(await readFile(resolve("migrations", migration), "utf8"));
  }
  const reminders = new ReminderRepository(client as never);
  await reminders.upsert({
    postId: "abcdefghijklmnopqrstuvwxyz",
    channelId: "channel",
    dueDate: "2026-09-01",
    content: "body",
    targetUsernamesJson: '["alice"]',
    updatedAt: "2026-08-30T00:00:00.000Z",
  });
  return { client, reminders };
}

describe("Turso reminder delivery claims", () => {
  it("keeps one pending post id across failure and retry", async () => {
    const { client, reminders } = await repository();
    const now = new Date("2026-08-31T15:00:00Z");
    const first = await reminders.claimDelivery(
      "abcdefghijklmnopqrstuvwxyz",
      "2026-09-01",
      now,
    );
    const concurrent = await reminders.claimDelivery(
      "abcdefghijklmnopqrstuvwxyz",
      "2026-09-01",
      now,
    );
    expect(first.claimed).toBe(true);
    expect(concurrent.claimed).toBe(false);
    expect(concurrent.pendingPostId).toBe(first.pendingPostId);

    await reminders.markDeliveryFailed(
      "abcdefghijklmnopqrstuvwxyz",
      "2026-09-01",
      first.claimToken,
      new Error("temporary failure"),
    );
    const retry = await reminders.claimDelivery(
      "abcdefghijklmnopqrstuvwxyz",
      "2026-09-01",
      new Date("2026-08-31T15:01:00Z"),
    );
    expect(retry.claimed).toBe(true);
    expect(retry.pendingPostId).toBe(first.pendingPostId);

    await reminders.markDeliverySent(
      "abcdefghijklmnopqrstuvwxyz",
      "2026-09-01",
      retry.claimToken,
      "reply-id",
    );
    const afterSuccess = await reminders.claimDelivery(
      "abcdefghijklmnopqrstuvwxyz",
      "2026-09-01",
      new Date("2026-08-31T16:00:00Z"),
    );
    expect(afterSuccess.claimed).toBe(false);
    expect(afterSuccess.pendingPostId).toBe(first.pendingPostId);
    client.close();
  });

  it("marks stop repeatedly without changing its outcome", async () => {
    const { client, reminders } = await repository();
    await reminders.markCompleted("abcdefghijklmnopqrstuvwxyz");
    await reminders.markCompleted("abcdefghijklmnopqrstuvwxyz");
    expect((await reminders.find("abcdefghijklmnopqrstuvwxyz"))?.completed).toBe(true);
    client.close();
  });
});
