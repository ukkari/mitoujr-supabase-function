import type { Env } from "../src/env";
import { MattermostClient } from "../src/mattermost";
import { addCalendarDays, jstDate } from "../src/domain/date";
import { emojiFor } from "./emoji";
import type { Reaction, VideoSource } from "./types";

const jstTime = (ms: number) => new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(11, 16);

function countReactions(reactions: Array<{ emoji_name: string }>): Reaction[] {
  const counts = new Map<string, number>();
  for (const { emoji_name } of reactions) counts.set(emoji_name, (counts.get(emoji_name) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ emoji: emojiFor(name), count }));
}

export async function collectVideoSource(env: Env, date: string, now = new Date()): Promise<VideoSource> {
  const client = new MattermostClient(env);
  const start = Date.parse(`${date}T00:00:00+09:00`);
  const end = Math.min(now.getTime(), Date.parse(`${addCalendarDays(date, 1)}T00:00:00+09:00`));
  const source: VideoSource = { date, label: date === jstDate(now) ? "今日" : "昨日", channels: [] };
  for (const channel of await client.fetchPublicChannels(env.MATTERMOST_MAIN_TEAM)) {
    if (channel.type !== "O" || channel.last_post_at < start ||
      channel.id === env.MATTERMOST_SUMMARY_CHANNEL || /notification/i.test(channel.display_name)) continue;
    const posts = (await client.fetchPostsInRange(channel.id, start, end, { appendReactions: false }))
      .filter((post) => !post.type && !post.delete_at && post.message.trim());
    if (!posts.length) continue;
    const replies = new Map<string, number>();
    for (const post of posts) if (post.root_id) replies.set(post.root_id, (replies.get(post.root_id) ?? 0) + 1);
    const items = [];
    for (const post of posts) {
      items.push({ id: post.id, userId: post.user_id, user: await client.fetchUsername(post.user_id),
        time: jstTime(post.create_at), message: post.message, reactions: countReactions(post.reactions ?? []),
        replies: post.root_id ? 0 : Math.max(post.reply_count ?? 0, replies.get(post.id) ?? 0) });
    }
    source.channels.push({ name: channel.display_name,
      url: `${env.MATTERMOST_URL.replace(/\/$/, "")}/mitoujr/channels/${encodeURIComponent(channel.name)}`,
      posts: items });
  }
  return source;
}
