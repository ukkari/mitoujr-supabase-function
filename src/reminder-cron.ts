import { ReminderRepository } from "./db";
import { calculateJstCalendarDayDifference, jstDate } from "./domain/date";
import {
  normalizeUsernames,
  parseReminderContent,
  reminderMessage,
  shouldSendReminder,
} from "./domain/reminder";
import type { Env } from "./env";
import { isDryRun } from "./env";
import { MattermostClient } from "./mattermost";

const DONE_EMOJIS = new Set(["done", "white_check_mark", "heavy_check_mark"]);

export type ReminderRunResult = {
  checked: number;
  completed: number;
  sent: number;
  skippedDuplicate: number;
  failed: number;
  dryRunMessages: Array<{ postId: string; message: string }>;
};

type ReminderCronRepository = Pick<
  ReminderRepository,
  | "listIncomplete"
  | "markCompleted"
  | "claimDelivery"
  | "markDeliverySent"
  | "markDeliveryFailed"
>;

type ReminderCronMattermost = Pick<
  MattermostClient,
  | "getMentors"
  | "getPost"
  | "getThreadPostIds"
  | "getReactions"
  | "getUsersByUsernames"
  | "postReply"
>;

export type ReminderCronDependencies = {
  repository?: ReminderCronRepository;
  mattermost?: ReminderCronMattermost;
};

export async function runReminderCron(
  env: Env,
  now = new Date(),
  dependencies: ReminderCronDependencies = {},
): Promise<ReminderRunResult> {
  const repository = dependencies.repository ?? ReminderRepository.fromEnv(env);
  const mattermost = dependencies.mattermost ?? new MattermostClient(env);
  const reminders = await repository.listIncomplete();
  const mentors = await mattermost.getMentors();
  if (mentors.length === 0 && reminders.some((item) =>
    parseReminderContent(item.content, item.targetUsernamesJson).targetUsernames === null
  )) {
    throw new Error("Mentor list is empty; refusing to process mentor reminders");
  }

  const result: ReminderRunResult = {
    checked: 0,
    completed: 0,
    sent: 0,
    skippedDuplicate: 0,
    failed: 0,
    dryRunMessages: [],
  };
  const deliveryDate = jstDate(now);

  for (const reminder of reminders) {
    result.checked += 1;
    try {
      const { post, notFound } = await mattermost.getPost(reminder.postId);
      if (notFound || (typeof post?.delete_at === "number" && post.delete_at > 0)) {
        if (!isDryRun(env)) await repository.markCompleted(reminder.postId);
        result.completed += 1;
        continue;
      }
      if (!post) continue;

      const diffDays = calculateJstCalendarDayDifference(reminder.dueDate, now);
      if (diffDays === null) continue;
      const threadPostIds = await mattermost.getThreadPostIds(reminder.postId);
      const doneUserIds = new Set<string>();
      for (const postId of threadPostIds) {
        for (const reaction of await mattermost.getReactions(postId)) {
          if (DONE_EMOJIS.has(reaction.emoji_name)) doneUserIds.add(reaction.user_id);
        }
      }

      const parsed = parseReminderContent(reminder.content, reminder.targetUsernamesJson);
      let hasPending = false;
      let missingMentions: string[];
      if (parsed.targetUsernames && parsed.targetUsernames.length > 0) {
        const normalized = normalizeUsernames(parsed.targetUsernames);
        const users = await mattermost.getUsersByUsernames(normalized);
        const found = new Set(users.map((user) => user.username));
        missingMentions = [
          ...users.filter((user) => !doneUserIds.has(user.id)).map((user) => `@${user.username}`),
          ...normalized.filter((username) => !found.has(username)).map((username) => `@${username}`),
        ];
        hasPending = missingMentions.length > 0;
      } else {
        missingMentions = mentors
          .filter((mentor) => !doneUserIds.has(mentor.id))
          .map((mentor) => `@${mentor.username}`);
        hasPending = missingMentions.length > 0;
      }

      if (!hasPending) {
        if (!isDryRun(env)) await repository.markCompleted(reminder.postId);
        result.completed += 1;
        continue;
      }
      if (!shouldSendReminder(diffDays)) continue;
      const message = reminderMessage(reminder.dueDate, diffDays, missingMentions);
      if (isDryRun(env)) {
        result.dryRunMessages.push({ postId: reminder.postId, message });
        continue;
      }

      const claim = await repository.claimDelivery(reminder.postId, deliveryDate, now);
      if (!claim.claimed) {
        result.skippedDuplicate += 1;
        continue;
      }
      try {
        const reply = await mattermost.postReply(
          reminder.channelId,
          reminder.postId,
          message,
          claim.pendingPostId,
        );
        await repository.markDeliverySent(
          reminder.postId,
          deliveryDate,
          claim.claimToken,
          reply.id ?? null,
        );
        result.sent += 1;
      } catch (error) {
        await repository.markDeliveryFailed(
          reminder.postId,
          deliveryDate,
          claim.claimToken,
          error,
        );
        result.failed += 1;
      }
    } catch (error) {
      result.failed += 1;
      console.error("Reminder processing failed", {
        postId: reminder.postId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
