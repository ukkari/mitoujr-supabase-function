import { getReactions } from "../../_shared/mattermost.ts";

const MATTERMOST_URL = Deno.env.get("MATTERMOST_URL") ?? "";
const MATTERMOST_BOT_TOKEN = Deno.env.get("MATTERMOST_BOT_TOKEN") ?? "";
const MATTERMOST_SUMMARY_CHANNEL = Deno.env.get("MATTERMOST_SUMMARY_CHANNEL") ??
  "";

const userNameCache: Record<string, string> = {};

export function formatChannelLink(displayName: string, name: string): string {
  return `[${displayName}](${MATTERMOST_URL}/mitoujr/channels/${name})`;
}

export async function fetchPublicChannels(
  teamId: string,
): Promise<any[] | null> {
  try {
    const url = `${MATTERMOST_URL}/api/v4/teams/${teamId}/channels?per_page=200`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${MATTERMOST_BOT_TOKEN}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      console.error("[fetchPublicChannels] failed", await res.text());
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error("[fetchPublicChannels] error:", err);
    return null;
  }
}

export async function postToMattermost(
  message: string,
  fileIds?: string[],
): Promise<void> {
  if (!MATTERMOST_SUMMARY_CHANNEL) {
    console.warn("MATTERMOST_SUMMARY_CHANNEL is not set. Skipping post.");
    return;
  }

  const url = `${MATTERMOST_URL}/api/v4/posts`;
  const body: Record<string, unknown> = {
    channel_id: MATTERMOST_SUMMARY_CHANNEL,
    message,
  };
  if (fileIds && fileIds.length > 0) {
    body.file_ids = fileIds;
  }
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MATTERMOST_BOT_TOKEN}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error("[postToMattermost] failed", errText);
    throw new Error(`Failed to post summary: ${errText}`);
  }
}

export async function fetchUserName(userId: string): Promise<string> {
  if (userNameCache[userId]) {
    return userNameCache[userId];
  }

  const url = `${MATTERMOST_URL}/api/v4/users/${userId}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${MATTERMOST_BOT_TOKEN}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    console.error(
      `[fetchUserName] Failed to fetch user data for ${userId}`,
      await res.text(),
    );
    userNameCache[userId] = "unknown";
    return "unknown";
  }

  const data = await res.json();
  userNameCache[userId] = data.username || "unknown";
  return userNameCache[userId];
}

async function isRestrictedChannel(channelId: string): Promise<boolean> {
  try {
    const url = `${MATTERMOST_URL}/api/v4/channels/${channelId}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${MATTERMOST_BOT_TOKEN}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      console.error("[isRestrictedChannel] failed", await res.text());
      return false;
    }

    const data = await res.json();
    const purpose = data.purpose || "";
    const header = data.header || "";

    return purpose.includes("🈲") || purpose.includes("🚫") ||
      header.includes("🈲") || header.includes("🚫");
  } catch (err) {
    console.error("[isRestrictedChannel] error:", err);
    return false;
  }
}

function isRestrictedThread(
  post: any,
  postsObj: Record<string, any>,
): boolean {
  const rootId = post.root_id || post.id;
  const rootPost = postsObj[rootId];
  if (!rootPost) return false;

  const message = rootPost.message || "";
  return message.trimStart().startsWith("🈲") ||
    message.trimStart().startsWith("🚫");
}

export async function fetchPostsInRange(
  channelId: string,
  startUTC: number,
  endUTC: number,
): Promise<any[]> {
  try {
    console.log(
      `Fetching posts in range for channel: ${channelId}, from ${new Date(startUTC).toISOString()} to ${new Date(endUTC).toISOString()}`,
    );

    const restricted = await isRestrictedChannel(channelId);
    if (restricted) {
      console.log(`Channel ${channelId} is restricted. Skipping.`);
      return [];
    }

    const url =
      `${MATTERMOST_URL}/api/v4/channels/${channelId}/posts?per_page=200`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${MATTERMOST_BOT_TOKEN}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      console.error("[fetchPostsInRange] failed", await res.text());
      return [];
    }

    const data = await res.json();
    if (!data.posts) {
      console.log("No posts found in response data.");
      return [];
    }

    const postIds: string[] = data.order || [];
    const postsObj = data.posts;

    const result: any[] = [];
    console.log(`Total posts in channel: ${postIds.length}`);
    let inRangeCount = 0;
    let restrictedCount = 0;

    for (const pid of postIds) {
      const p = postsObj[pid];
      if (p && p.create_at >= startUTC && p.create_at < endUTC) {
        inRangeCount++;
        console.log(
          `Processing post: ${p.id} (created at ${new Date(p.create_at).toISOString()})`,
        );

        if (isRestrictedThread(p, postsObj)) {
          console.log(`Post ${p.id} is in a restricted thread. Skipping.`);
          restrictedCount++;
          continue;
        }

        try {
          console.log(`Fetching reactions for post: ${p.id}`);
          // getReactions should return an array, but guard against null/undefined
          const reactions = (await getReactions(p.id)) ?? [];
          if (Array.isArray(reactions) && reactions.length > 0) {
            const reactionStrings: string[] = [];
            for (const r of reactions) {
              const userName = await fetchUserName(r.user_id);
              reactionStrings.push(`:${r.emoji_name}: by @${userName}`);
            }
            p.message += `\n\n---\nReactions:\n${reactionStrings.join("\n")}`;
          }
        } catch (err) {
          console.log(`No reactions for post ${p.id}`, err);
        }

        result.push(p);
      }
    }

    result.sort((a, b) => a.create_at - b.create_at);
    console.log(
      `Posts summary: ${inRangeCount} in range, ${restrictedCount} restricted, ${result.length} included in results`,
    );
    return result;
  } catch (err) {
    console.error("[fetchPostsInRange] error:", err);
    return [];
  }
}

async function uploadFileToMattermost(
  channelId: string,
  fileName: string,
  fileBytes: Uint8Array,
  mimeType = "image/png",
): Promise<string> {
  const url = `${MATTERMOST_URL}/api/v4/files`;
  const formData = new FormData();
  formData.append("channel_id", channelId);
  formData.append(
    "files",
    new Blob([fileBytes], { type: mimeType }),
    fileName,
  );

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MATTERMOST_BOT_TOKEN}`,
      Accept: "application/json",
    },
    body: formData,
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("[uploadFileToMattermost] failed", errText);
    throw new Error(`Failed to upload file to Mattermost: ${errText}`);
  }

  const data = await res.json();
  const fileId =
    data?.file_infos?.[0]?.id ??
      (Array.isArray(data?.file_ids) ? data.file_ids[0] : data?.id);

  if (!fileId) {
    console.error("[uploadFileToMattermost] unexpected response", data);
    throw new Error("Failed to retrieve file_id from Mattermost upload");
  }

  return fileId;
}

export async function postMessageWithImage(
  message: string,
  imageBytes: Uint8Array,
  options?: { fileName?: string; mimeType?: string; altText?: string },
): Promise<void> {
  if (!MATTERMOST_SUMMARY_CHANNEL) {
    console.warn("MATTERMOST_SUMMARY_CHANNEL is not set. Skipping post.");
    return;
  }

  const fileId = await uploadFileToMattermost(
    MATTERMOST_SUMMARY_CHANNEL,
    options?.fileName ?? "channel-summary.png",
    imageBytes,
    options?.mimeType ?? "image/png",
  );

  const finalMessage = options?.altText
    ? `${message}\n\n(画像の説明: ${options.altText})`
    : message;

  await postToMattermost(finalMessage, [fileId]);
}

export { MATTERMOST_URL, MATTERMOST_SUMMARY_CHANNEL };
