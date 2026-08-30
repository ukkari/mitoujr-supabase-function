import { Hono } from "hono";
import { ReminderRepository } from "../db";
import type { Env } from "../env";
import { MattermostClient } from "../mattermost";
import { parseSlashDate } from "../domain/date";
import { normalizeUsernames } from "../domain/reminder";

const POST_ID_REGEX = /^[A-Za-z0-9]{26}$/;
const POST_LINK_REGEX = /\/pl\/([A-Za-z0-9]{26})/;

type ExpandedMentions = {
  targetUsernames: string[];
  unresolvedMentions: string[];
};

export function extractPostId(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const link = trimmed.match(POST_LINK_REGEX)?.[1];
  if (link) return link;
  const token = trimmed.split(/\s+/)[0]?.replace(/[<>]/g, "") ?? "";
  return POST_ID_REGEX.test(token) ? token : null;
}

export async function secureEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

export async function expandMentions(
  rawMentions: string[],
  mattermost: MattermostClient,
): Promise<ExpandedMentions> {
  const resolved: string[] = [];
  const unresolvedMentions: string[] = [];
  for (const mention of normalizeUsernames(rawMentions)) {
    const user = await mattermost.getUserByUsername(mention);
    if (user) {
      resolved.push(user.username);
      continue;
    }
    const group = await mattermost.getUserGroupByName(mention);
    if (!group) {
      unresolvedMentions.push(mention);
      continue;
    }
    const members = await mattermost.getUserGroupMembers(group.id);
    if (members.length === 0) {
      unresolvedMentions.push(mention);
      continue;
    }
    resolved.push(...members.map((member) => member.username));
  }
  return {
    targetUsernames: normalizeUsernames(resolved),
    unresolvedMentions,
  };
}

async function stopReminder(
  initialPostId: string,
  fallbackChannelId: string,
  repository: ReminderRepository,
  mattermost: MattermostClient,
  command: "/reminder" | "/reminder-mentors",
) {
  let reminder = await repository.find(initialPostId);
  let rootId = reminder?.postId ?? "";
  let channelId = reminder?.channelId ?? fallbackChannelId;

  if (!reminder) {
    const { post, notFound } = await mattermost.getPost(initialPostId);
    if (notFound || !post) {
      return { text: "指定されたポストが見つかりませんでした。", status: 200 };
    }
    rootId = post.root_id || post.id;
    channelId = post.channel_id || fallbackChannelId;
    reminder = await repository.find(rootId);
    if (!reminder) {
      return { text: "reminders テーブルに対象が見つかりませんでした。", status: 200 };
    }
  }

  const alreadyCompleted = reminder.completed;
  await repository.markCompleted(rootId);
  if (channelId) {
    await mattermost.postReply(
      channelId,
      rootId,
      alreadyCompleted
        ? "このリマインドは既に停止済み（completed=true）です。"
        : `このリマインドは ${command} stop により停止されました。`,
    );
  }
  return {
    text: alreadyCompleted
      ? "このリマインドは既に停止済みです。"
      : "リマインドを停止しました（completed=true）。",
    status: 200,
  };
}

function jsonText(text: string, status = 200): Response {
  return Response.json({ text }, { status });
}

export function registerSlashRoutes(app: Hono<{ Bindings: Env }>) {
  app.post("/slash-reminder", async (context) => {
    const form = await context.req.formData();
    const token = String(form.get("token") ?? "");
    if (!await secureEqual(token, context.env.MATTERMOST_SLASH_REMINDER_TOKEN)) {
      return jsonText("Invalid slash command token", 403);
    }
    const text = String(form.get("text") ?? "");
    const channelId = String(form.get("channel_id") ?? "");
    if (!text || !channelId) return jsonText("Missing text or channel_id", 400);

    const repository = ReminderRepository.fromEnv(context.env);
    const mattermost = new MattermostClient(context.env);
    const trimmed = text.trim();
    if (trimmed.split(/\s+/)[0]?.toLowerCase() === "stop") {
      const postId = extractPostId(trimmed.slice(4));
      if (!postId) {
        return jsonText(
          "停止対象の post_id が特定できませんでした。\nUsage: /reminder stop <post_id|post_link>",
        );
      }
      const result = await stopReminder(
        postId,
        channelId,
        repository,
        mattermost,
        "/reminder",
      );
      return jsonText(result.text, result.status);
    }

    const matched = text.match(/^(\S+)\s+([\s\S]+)/);
    if (!matched) return jsonText("Invalid format.\nUsage: /reminder YYYY/MM/DD @user1 @user2 contents...");
    const dueDate = parseSlashDate(matched[1]);
    if (!dueDate) return jsonText("Invalid date format. Use YYYY/MM/DD");
    const mentions = matched[2].match(/^((?:@\S+\s+)+)([\s\S]*)$/);
    if (!mentions || !mentions[2].trim()) {
      return jsonText("Invalid format.\nUsage: /reminder YYYY/MM/DD @user1 @user2 contents...");
    }
    const expanded = await expandMentions(mentions[1].trim().split(/\s+/), mattermost);
    if (expanded.unresolvedMentions.length > 0) {
      return jsonText(
        `対象のユーザーまたはUser Groupを取得できませんでした: ${expanded.unresolvedMentions.map((name) => `@${name}`).join(" ")}`,
      );
    }
    if (expanded.targetUsernames.length === 0) {
      return jsonText("Invalid format.\nUsage: /reminder YYYY/MM/DD @user1 @user2 contents...");
    }

    const contents = mentions[2].trimStart();
    const mentionText = expanded.targetUsernames.map((name) => `@${name}`).join(" ");
    const post = await mattermost.createPost(
      channelId,
      `リマインド対象のタスクが作られました。自動でリマインダされます。\n**対象:** ${mentionText}\n**締切日:** ${matched[1]}\n完了したらこのポストに :done: リアクションを付けてください。\n${contents}`,
    );
    try {
      await repository.upsert({
        postId: post.id,
        channelId,
        dueDate,
        content: contents,
        targetUsernamesJson: JSON.stringify(expanded.targetUsernames),
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      await mattermost.postReply(
        channelId,
        post.id,
        "リマインダーの登録に失敗しました。管理者に連絡してください。",
      ).catch(() => undefined);
      throw error;
    }
    return jsonText(`リマインド用ポストを作成しました。\n対象: ${mentionText}\n締切日: ${matched[1]}`);
  });

  app.post("/slash-reminder-mentors", async (context) => {
    const form = await context.req.formData();
    const token = String(form.get("token") ?? "");
    if (!await secureEqual(token, context.env.MATTERMOST_SLASH_TOKEN)) {
      return jsonText("Invalid slash command token", 403);
    }
    const text = String(form.get("text") ?? "");
    const channelId = String(form.get("channel_id") ?? "");
    if (!text || !channelId) return jsonText("Missing text or channel_id", 400);
    const repository = ReminderRepository.fromEnv(context.env);
    const mattermost = new MattermostClient(context.env);
    const trimmed = text.trim();
    if (trimmed.split(/\s+/)[0]?.toLowerCase() === "stop") {
      const postId = extractPostId(trimmed.slice(4));
      if (!postId) {
        return jsonText(
          "停止対象の post_id が特定できませんでした。\nUsage: /reminder-mentors stop <post_id|post_link>",
        );
      }
      const result = await stopReminder(
        postId,
        channelId,
        repository,
        mattermost,
        "/reminder-mentors",
      );
      return jsonText(result.text, result.status);
    }
    const matched = text.match(/^(\S+)\s([\s\S]+)/);
    if (!matched) return jsonText("Invalid format.\nUsage: /reminder-mentors YYYY/MM/DD contents...");
    const dueDate = parseSlashDate(matched[1]);
    if (!dueDate) return jsonText("Invalid date format. Use YYYY/MM/DD");
    const contents = matched[2];
    const post = await mattermost.createPost(
      channelId,
      `新しいメンター向けのタスクが作られました。自動でリマインダされます。\n**締切日:** ${matched[1]}\n${contents}`,
    );
    try {
      await repository.upsert({
        postId: post.id,
        channelId,
        dueDate,
        content: contents,
        targetUsernamesJson: null,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      await mattermost.postReply(
        channelId,
        post.id,
        "リマインダーの登録に失敗しました。管理者に連絡してください。",
      ).catch(() => undefined);
      throw error;
    }
    return jsonText(`リマインド用ポストを作成しました。\n締切日: ${matched[1]}`);
  });
}
