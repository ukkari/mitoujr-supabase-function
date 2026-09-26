import type { Env } from "../src/env";
import { MattermostClient } from "../src/mattermost";
import { addCalendarDays, jstDate } from "../src/domain/date";
import type { VideoSource } from "./types";

export async function collectVideoSource(env: Env, date: string, now = new Date()): Promise<VideoSource> {
  const client = new MattermostClient(env);
  const start = Date.parse(`${date}T00:00:00+09:00`);
  const end = Math.min(now.getTime(), Date.parse(`${addCalendarDays(date, 1)}T00:00:00+09:00`));
  const source: VideoSource = { date, label: date === jstDate(now) ? "今日" : "昨日", channels: [] };
  for (const channel of await client.fetchPublicChannels(env.MATTERMOST_MAIN_TEAM)) {
    if (channel.type !== "O" || channel.last_post_at < start ||
      channel.id === env.MATTERMOST_SUMMARY_CHANNEL || /notification/i.test(channel.display_name)) continue;
    const posts = (await client.fetchPostsInRange(channel.id, start, end))
      .filter((post) => !post.type && !post.delete_at && post.message.trim());
    if (!posts.length) continue;
    const lines = [];
    for (const post of posts) {
      lines.push(`${await client.fetchUsername(post.user_id)}: ${post.message}`);
    }
    source.channels.push({ name: channel.display_name,
      url: `${env.MATTERMOST_URL.replace(/\/$/, "")}/mitoujr/channels/${encodeURIComponent(channel.name)}`,
      text: lines.join("\n") });
  }
  return source;
}
