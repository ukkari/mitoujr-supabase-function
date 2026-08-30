import type { Env } from "./env";

export type MattermostUser = { id: string; username: string };
export type MattermostPost = {
  id: string;
  channel_id: string;
  user_id: string;
  root_id?: string;
  message: string;
  create_at: number;
  delete_at?: number;
};
export type MattermostReaction = { user_id: string; emoji_name: string };
export type MattermostChannel = {
  id: string;
  name: string;
  display_name: string;
  type: string;
  last_post_at: number;
};

export class MattermostClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly mentorGroupId: string;
  private readonly summaryChannelId: string;
  private readonly usernameCache = new Map<string, string>();

  constructor(env: Pick<
    Env,
    | "MATTERMOST_URL"
    | "MATTERMOST_BOT_TOKEN"
    | "MATTERMOST_MENTOR_GROUP_ID"
    | "MATTERMOST_SUMMARY_CHANNEL"
  >) {
    this.baseUrl = env.MATTERMOST_URL.replace(/\/$/, "");
    this.token = env.MATTERMOST_BOT_TOKEN;
    this.mentorGroupId = env.MATTERMOST_MENTOR_GROUP_ID;
    this.summaryChannelId = env.MATTERMOST_SUMMARY_CHANNEL;
  }

  private headers(json = false): HeadersInit {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
      ...(json ? { "Content-Type": "application/json" } : {}),
    };
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: init?.headers ?? this.headers(Boolean(init?.body)),
    });
    if (!response.ok) {
      throw new Error(`Mattermost ${init?.method ?? "GET"} ${path} failed (${response.status})`);
    }
    return await response.json() as T;
  }

  async getMentors(): Promise<MattermostUser[]> {
    const users = await this.request<Array<Record<string, unknown>>>(
      `/api/v4/users?in_group=${encodeURIComponent(this.mentorGroupId)}&per_page=200`,
    );
    return users.flatMap((user) =>
      typeof user.id === "string" && typeof user.username === "string"
        ? [{ id: user.id, username: user.username }]
        : []
    );
  }

  async getUserByUsername(username: string): Promise<MattermostUser | null> {
    const normalized = username.replace(/^@/, "").trim();
    if (!normalized) return null;
    const path = `/api/v4/users/username/${encodeURIComponent(normalized)}`;
    const response = await fetch(`${this.baseUrl}${path}`, { headers: this.headers() });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Mattermost GET ${path} failed (${response.status})`);
    const user = await response.json() as Record<string, unknown>;
    return typeof user.id === "string" && typeof user.username === "string"
      ? { id: user.id, username: user.username }
      : null;
  }

  async getUsersByUsernames(usernames: string[]): Promise<MattermostUser[]> {
    const unique = Array.from(new Set(usernames.map((name) =>
      name.replace(/^@/, "").trim()
    ).filter(Boolean)));
    const users = await Promise.all(unique.map((name) => this.getUserByUsername(name)));
    return users.filter((user): user is MattermostUser => user !== null);
  }

  async getUserGroupByName(name: string): Promise<{ id: string; name: string } | null> {
    const normalized = name.replace(/^@/, "").trim();
    if (!normalized) return null;
    const data = await this.request<unknown>(
      `/api/v4/groups?q=${encodeURIComponent(normalized)}&filter_allow_reference=true&per_page=200`,
    );
    const record = data as { groups?: unknown[] };
    const groups = Array.isArray(data) ? data : Array.isArray(record.groups) ? record.groups : [];
    const group = groups.find((candidate) => {
      const item = candidate as Record<string, unknown>;
      return item.name === normalized;
    }) as Record<string, unknown> | undefined;
    return group && typeof group.id === "string" && typeof group.name === "string"
      ? { id: group.id, name: group.name }
      : null;
  }

  async getUserGroupMembers(groupId: string): Promise<MattermostUser[]> {
    const members = new Map<string, MattermostUser>();
    const perPage = 200;
    for (let page = 0; page < 100; page += 1) {
      const data = await this.request<unknown>(
        `/api/v4/groups/${encodeURIComponent(groupId)}/members?page=${page}&per_page=${perPage}`,
      );
      const record = data as { members?: unknown[]; total_member_count?: number };
      const pageMembers = Array.isArray(data)
        ? data
        : Array.isArray(record.members) ? record.members : [];
      for (const raw of pageMembers) {
        const item = raw as Record<string, unknown>;
        const id = typeof item.id === "string" ? item.id : item.user_id;
        if (typeof id === "string" && typeof item.username === "string") {
          members.set(id, { id, username: item.username });
        }
      }
      if (
        pageMembers.length < perPage ||
        (typeof record.total_member_count === "number" && members.size >= record.total_member_count)
      ) break;
    }
    return Array.from(members.values());
  }

  async getPost(postId: string): Promise<{ post: MattermostPost | null; notFound: boolean }> {
    const path = `/api/v4/posts/${encodeURIComponent(postId)}`;
    const response = await fetch(`${this.baseUrl}${path}`, { headers: this.headers() });
    if (response.status === 404) return { post: null, notFound: true };
    if (!response.ok) return { post: null, notFound: false };
    return { post: await response.json() as MattermostPost, notFound: false };
  }

  async getThreadPostIds(rootId: string): Promise<string[]> {
    const data = await this.request<{ posts?: Record<string, unknown> }>(
      `/api/v4/posts/${encodeURIComponent(rootId)}/thread`,
    );
    const ids = Object.keys(data.posts ?? {});
    return ids.length > 0 ? ids : [rootId];
  }

  async getReactions(postId: string): Promise<MattermostReaction[]> {
    try {
      const reactions = await this.request<MattermostReaction[] | null>(
        `/api/v4/posts/${encodeURIComponent(postId)}/reactions`,
      );
      return Array.isArray(reactions) ? reactions : [];
    } catch {
      return [];
    }
  }

  async createPost(
    channelId: string,
    message: string,
    pendingPostId?: string,
  ): Promise<MattermostPost> {
    const existing = pendingPostId ? await this.findPostByPendingId(pendingPostId) : null;
    if (existing) return existing;
    return await this.request<MattermostPost>("/api/v4/posts", {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({
        channel_id: channelId,
        message,
        ...(pendingPostId ? { pending_post_id: pendingPostId } : {}),
      }),
    });
  }

  async postReply(
    channelId: string,
    rootId: string,
    message: string,
    pendingPostId?: string,
  ): Promise<MattermostPost> {
    const existing = pendingPostId ? await this.findPostByPendingId(pendingPostId) : null;
    if (existing) return existing;
    return await this.request<MattermostPost>("/api/v4/posts", {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({
        channel_id: channelId,
        root_id: rootId,
        message,
        ...(pendingPostId ? { pending_post_id: pendingPostId } : {}),
      }),
    });
  }

  private async findPostByPendingId(pendingPostId: string): Promise<MattermostPost | null> {
    const response = await fetch(
      `${this.baseUrl}/api/v4/posts/${encodeURIComponent(pendingPostId)}`,
      { headers: this.headers() },
    );
    if (!response.ok) return null;
    return await response.json() as MattermostPost;
  }

  async fetchPublicChannels(teamId: string): Promise<MattermostChannel[]> {
    const all: MattermostChannel[] = [];
    for (let page = 0; page <= 50; page += 1) {
      const channels = await this.request<MattermostChannel[]>(
        `/api/v4/teams/${encodeURIComponent(teamId)}/channels?per_page=200&page=${page}`,
      );
      all.push(...channels);
      if (channels.length < 200) break;
    }
    return all;
  }

  private async isRestrictedChannel(channelId: string): Promise<boolean> {
    try {
      const channel = await this.request<{ purpose?: string; header?: string }>(
        `/api/v4/channels/${encodeURIComponent(channelId)}`,
      );
      const text = `${channel.purpose ?? ""}\n${channel.header ?? ""}`;
      return text.includes("🈲") || text.includes("🚫");
    } catch (error) {
      console.error("Restricted-channel check failed; skipping channel", {
        channelId,
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  }

  async fetchPostsInRange(
    channelId: string,
    startTimeUtc: number,
    endTimeUtc: number,
  ): Promise<MattermostPost[]> {
    if (await this.isRestrictedChannel(channelId)) return [];
    const data = await this.request<{
      order?: string[];
      posts?: Record<string, MattermostPost>;
    }>(`/api/v4/channels/${encodeURIComponent(channelId)}/posts?per_page=500`);
    const posts = data.posts ?? {};
    const selected: MattermostPost[] = [];
    for (const id of data.order ?? []) {
      const post = posts[id];
      if (!post || post.create_at < startTimeUtc || post.create_at >= endTimeUtc) continue;
      const root = posts[post.root_id || post.id];
      const rootMessage = root?.message?.trimStart() ?? "";
      if (rootMessage.startsWith("🈲") || rootMessage.startsWith("🚫")) continue;
      const reactions = await this.getReactions(post.id);
      if (reactions.length > 0) {
        const formatted = await Promise.all(reactions.map(async (reaction) =>
          `:${reaction.emoji_name}: by @${await this.fetchUsername(reaction.user_id)}`
        ));
        post.message = `${post.message}\n\n---\nReactions:\n${formatted.join("\n")}`;
      }
      selected.push(post);
    }
    return selected.sort((left, right) => left.create_at - right.create_at);
  }

  async fetchUsername(userId: string): Promise<string> {
    const cached = this.usernameCache.get(userId);
    if (cached) return cached;
    try {
      const user = await this.request<{ username?: string }>(
        `/api/v4/users/${encodeURIComponent(userId)}`,
      );
      const username = user.username ?? "unknown";
      this.usernameCache.set(userId, username);
      return username;
    } catch {
      return "unknown";
    }
  }

  channelLink(channel: MattermostChannel): string {
    return `[${channel.display_name}](${this.baseUrl}/mitoujr/channels/${channel.name})`;
  }

  async postSummary(
    message: string,
    image?: { bytes: Uint8Array; altText?: string },
    pendingPostId?: string,
  ) {
    if (!image) return await this.createPost(this.summaryChannelId, message, pendingPostId);
    const fileId = await this.uploadSummaryFile(image.bytes);
    return await this.postSummaryWithFile(
      message,
      fileId,
      image.altText,
      pendingPostId,
    );
  }

  async postSummaryWithFile(
    message: string,
    fileId: string | null,
    altText?: string,
    pendingPostId?: string,
  ) {
    if (!fileId) return await this.createPost(this.summaryChannelId, message, pendingPostId);
    const existing = pendingPostId ? await this.findPostByPendingId(pendingPostId) : null;
    if (existing) return existing;
    const finalMessage = altText
      ? `${message}\n\n(画像の説明: ${altText})`
      : message;
    return await this.request<MattermostPost>("/api/v4/posts", {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({
        channel_id: this.summaryChannelId,
        message: finalMessage,
        file_ids: [fileId],
        ...(pendingPostId ? { pending_post_id: pendingPostId } : {}),
      }),
    });
  }

  async uploadSummaryFile(bytes: Uint8Array): Promise<string> {
    const form = new FormData();
    form.append("channel_id", this.summaryChannelId);
    const arrayBuffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    form.append("files", new Blob([arrayBuffer], { type: "image/png" }), "channel-summary.png");
    const response = await fetch(`${this.baseUrl}/api/v4/files`, {
      method: "POST",
      headers: this.headers(),
      body: form,
    });
    if (!response.ok) throw new Error(`Mattermost file upload failed (${response.status})`);
    const data = await response.json() as {
      file_infos?: Array<{ id?: string }>;
      file_ids?: string[];
      id?: string;
    };
    const fileId = data.file_infos?.[0]?.id ?? data.file_ids?.[0] ?? data.id;
    if (!fileId) throw new Error("Mattermost file upload returned no file id");
    return fileId;
  }
}
