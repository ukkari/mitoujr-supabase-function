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
  type?: string;
  props?: Record<string, unknown>;
  reply_count?: number;
  reactions?: MattermostReaction[];
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
      signal: init?.signal ?? AbortSignal.timeout(30_000),
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
    { appendReactions = true }: { appendReactions?: boolean } = {},
  ): Promise<MattermostPost[]> {
    if (await this.isRestrictedChannel(channelId)) return [];
    const posts: Record<string, MattermostPost> = {};
    for (let page = 0; ; page += 1) {
      if (page >= 100) throw new Error("Mattermost daily collection exceeded its page limit");
      const data = await this.request<{ order?: string[]; posts?: Record<string, MattermostPost> }>(
        `/api/v4/channels/${encodeURIComponent(channelId)}/posts?per_page=200&page=${page}`,
      );
      const batch = (data.order ?? []).map((id) => data.posts?.[id]).filter((post): post is MattermostPost => Boolean(post));
      for (const post of batch) posts[post.id] = post;
      if (batch.length < 200 || batch.some((post) => post.create_at < startTimeUtc)) break;
    }
    const selected: MattermostPost[] = [];
    const roots = new Map<string, MattermostPost | null>();
    for (const post of Object.values(posts)) {
      if (post.delete_at || post.create_at < startTimeUtc || post.create_at >= endTimeUtc) continue;
      if (post.root_id && !posts[post.root_id] && !roots.has(post.root_id)) {
        roots.set(post.root_id, (await this.getPost(post.root_id)).post);
      }
      const root = posts[post.root_id || post.id] ?? roots.get(post.root_id || post.id);
      // A recent reply may have an old, restricted root outside the collected page.
      if (!root || root.delete_at || root.channel_id !== channelId) continue;
      const rootMessage = root?.message?.trimStart() ?? "";
      if (rootMessage.startsWith("🈲") || rootMessage.startsWith("🚫")) continue;
      const reactions = await this.getReactions(post.id);
      post.reactions = reactions;
      if (appendReactions && reactions.length > 0) {
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

  private async fetchImage(path: string): Promise<{ bytes: ArrayBuffer; type: string } | null> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: "image/*" },
      signal: AbortSignal.timeout(15_000),
    });
    const type = response.headers.get("Content-Type")?.split(";")[0].trim() ?? "";
    if (!response.ok || !/^image\/(png|jpeg|gif|webp)$/.test(type)) {
      await response.body?.cancel();
      return null;
    }
    const bytes = await response.arrayBuffer();
    return bytes.byteLength > 0 && bytes.byteLength <= 2 * 1024 * 1024 ? { bytes, type } : null;
  }

  async fetchUserImage(userId: string): Promise<{ bytes: ArrayBuffer; type: string } | null> {
    return await this.fetchImage(`/api/v4/users/${encodeURIComponent(userId)}/image`);
  }

  async fetchCustomEmojiImage(name: string): Promise<{ bytes: ArrayBuffer; type: string } | null> {
    try {
      const emoji = await this.request<{ id?: string }>(`/api/v4/emoji/name/${encodeURIComponent(name)}`);
      return typeof emoji.id === "string" ? await this.fetchImage(`/api/v4/emoji/${encodeURIComponent(emoji.id)}/image`) : null;
    } catch {
      return null;
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

  async findVideoSummary(date: string): Promise<MattermostPost | null> {
    // Reconcile a lost POST response before retrying. Fail closed if lookup fails.
    const bot = await this.request<MattermostUser>("/api/v4/users/me");
    for (let page = 0; page < 50; page += 1) {
      const data = await this.request<{ order: string[]; posts: Record<string, MattermostPost> }>(
        `/api/v4/channels/${encodeURIComponent(this.summaryChannelId)}/posts?per_page=100&page=${page}`,
      );
      const posts = data.order.map((id) => data.posts[id]).filter(Boolean);
      const found = posts.find((post) => !post.delete_at && post.user_id === bot.id && post.props?.summary_video_date === date);
      if (found) return found;
      if (posts.length < 100) return null;
    }
    throw new Error("Video post reconciliation exceeded its page limit");
  }

  async postVideoSummary(date: string, message: string, fileId: string, rootId?: string) {
    return await this.request<MattermostPost>("/api/v4/posts", {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ channel_id: this.summaryChannelId, message, file_ids: [fileId],
        ...(rootId ? { root_id: rootId } : {}),
        props: { summary_video_date: date }, pending_post_id: `summary-video-${date}` }),
    });
  }

  async uploadSummaryFile(
    bytes: Uint8Array,
    file: { name: string; type: string } = { name: "channel-summary.png", type: "image/png" },
  ): Promise<string> {
    const form = new FormData();
    form.append("channel_id", this.summaryChannelId);
    form.append("files", new Blob([bytes as Uint8Array<ArrayBuffer>], { type: file.type }), file.name);
    const response = await fetch(`${this.baseUrl}/api/v4/files`, {
      method: "POST",
      signal: AbortSignal.timeout(60_000),
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
