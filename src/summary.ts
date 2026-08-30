import OpenAI, { toFile } from "openai";
import type { Env, SummaryTarget } from "./env";
import { addCalendarDays, summaryTimeRange } from "./domain/date";
import { MattermostClient } from "./mattermost";
import type { MattermostChannel } from "./mattermost";
import { ZUNDA_BASE64 } from "../supabase/functions/today-channels-summary/assets/zunda-base64";

export type SummaryInput = {
  summaryRaw: string;
  label: "昨日" | "今日";
  targetDateJst: string;
};

export type SummaryCollectionPlan = {
  channels: MattermostChannel[];
  label: "昨日" | "今日";
  targetDateJst: string;
  startTimeUtc: number;
  endTimeUtc: number;
};

export function targetRange(
  target: SummaryTarget,
  targetDateJst: string,
  now = new Date(),
) {
  const startTimeUtc = Date.parse(`${targetDateJst}T00:00:00+09:00`);
  const endTimeUtc = target === "today"
    ? now.getTime()
    : Date.parse(`${addCalendarDays(targetDateJst, 1)}T00:00:00+09:00`);
  return {
    startTimeUtc,
    endTimeUtc,
    label: target === "today" ? "今日" as const : "昨日" as const,
  };
}

export async function collectSummaryInput(
  env: Env,
  target: SummaryTarget,
  targetDateJst: string,
): Promise<SummaryInput> {
  const plan = await prepareSummaryCollection(env, target, targetDateJst);
  let summaryRaw = "";
  for (const channel of plan.channels) {
    summaryRaw += await collectSummaryChannel(env, plan, channel);
  }
  return {
    summaryRaw,
    label: plan.label,
    targetDateJst,
  };
}

export async function prepareSummaryCollection(
  env: Env,
  target: SummaryTarget,
  targetDateJst: string,
): Promise<SummaryCollectionPlan> {
  const mattermost = new MattermostClient(env);
  const range = targetRange(target, targetDateJst);
  const channels = await mattermost.fetchPublicChannels(env.MATTERMOST_MAIN_TEAM);
  const updated = channels.filter((channel) =>
    channel.type === "O" &&
    channel.last_post_at >= range.startTimeUtc &&
    channel.id !== env.MATTERMOST_SUMMARY_CHANNEL &&
    !channel.display_name.toLowerCase().includes("notification")
  );
  return {
    channels: updated.map((channel) => ({
      id: channel.id,
      name: channel.name,
      display_name: channel.display_name,
      type: channel.type,
      last_post_at: channel.last_post_at,
    })),
    label: range.label,
    targetDateJst,
    startTimeUtc: range.startTimeUtc,
    endTimeUtc: range.endTimeUtc,
  };
}

export async function collectSummaryChannel(
  env: Env,
  plan: SummaryCollectionPlan,
  channel: MattermostChannel,
): Promise<string> {
  const mattermost = new MattermostClient(env);
  const posts = await mattermost.fetchPostsInRange(
    channel.id,
    plan.startTimeUtc,
    plan.endTimeUtc,
  );
  if (posts.length === 0) return "";
  let fragment = `\n【チャンネル】${mattermost.channelLink(channel)}\n`;
  for (const post of posts) {
    const username = await mattermost.fetchUsername(post.user_id);
    const message = post.message.replace(/@([a-zA-Z0-9._-]+)/g, "$1");
    fragment += `  - ${username}: ${message}\n`;
  }
  return `${fragment}\n`;
}

export async function generateTextSummary(env: Env, input: SummaryInput): Promise<string> {
  const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY, maxRetries: 0 });
  const prompt = `ずんだもんとして、${input.label}のMattermost投稿について、全体の概要のあとに、チャンネルごとにまとめてください。(入室メッセージしかなかったチャンネルを除く)

** ステップ **
1. 全体の投稿概要を最初にまとめて表示してください。読む人がワクワクするように、絵文字も含めて、プロとして面白いまとめにしてください。

2. 続いて、更新があったチャンネルごとに、誰からどのような投稿があったのかを絵文字も使ってポップにまとめて。
- 決して、すべての投稿を羅列しないでください。(e.g. XXXがYYYと言った、の羅列)
- もし、チャンネルに「が入室しました」のような誰かが入室したことを示すシステムメッセージの投稿しかなかった場合は、チャンネル自体をまとめに含めないでください。
- 「が入室しました」のようなMattermostのシステムメッセージは、まとめに含めないでください。
- emoji がリアクションに使われていたら、うまくそれもまとめに含めてください。
3. 最後にかならず、「${input.label}一番おもしろかったチャンネル」を選んで、「ずんだもん」として表彰してください。なにが面白かったのか、今後どんな投稿があるといいのかに言及しつつ「ずんだもん」として落としてください。

** 全体の指示 **
- Mattermostのポストやチャンネルへのリンクは、必ず以下のフォーマットを使ってリンクをしてください。
[z-times-hoge](https://mattermost.jr.mitou.org/mitoujr/channels/z-times-hoge)
- :face_palm: のような記載は、emojiなので、前後に半角スペースを入れてそのまま残してください。

** ずんだもんのルール **
- ずんだもんなのだ！と自己紹介をしてから回答すること
- ずんだ餅の精霊。一人称は、「ボク」または「ずんだもん」を使う。
- 口調は親しみやすく、語尾に「〜のだ」「〜なのだ」を使う。敬語は使用しないこと。
- 明るく元気でフレンドリーな性格。
- 難しい話題も簡単に解説する。

【セリフ例】
「今からPythonでコードを書くのだ！」
「おじさんは嫌いなのだ！」
「ずんだもんはお前のお手伝いをするのだ！」
「僕に任せるのだ！」

${input.summaryRaw}`;
  let completion;
  try {
    completion = await openai.chat.completions.create({
      model: env.OPENAI_TEXT_MODEL || "gpt-5.6-luna",
      reasoning_effort: "none",
      messages: [
        {
          role: "system",
          content:
            "You are a helpful assistant summarizing multiple posts on Mattermost channel. 日本語の響きを重視して、美しく、芸術作品のようにまとめます。",
        },
        { role: "user", content: prompt },
      ],
    });
  } catch (error) {
    throw sanitizedOpenAiError("text generation", error);
  }
  const summary = completion.choices[0]?.message?.content?.trim();
  if (!summary) throw new Error("OpenAI returned no text summary");
  return summary;
}

export async function generateSummaryImage(
  env: Env,
  summary: string,
  input: SummaryInput,
): Promise<{ bytes: Uint8Array; altText: string }> {
  const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY, maxRetries: 0 });
  const referenceBytes = decodeBase64(ZUNDA_BASE64);
  const reference = await toFile(referenceBytes, "zundamon-reference.png", {
    type: "image/png",
  });
  const trimmed = summary.length > 3500 ? `${summary.slice(0, 3500)}...` : summary;
  const response = await openai.images.edit({
    model: env.OPENAI_IMAGE_MODEL || "gpt-image-2",
    image: reference,
    prompt: `Create a polished 16:9 landscape infographic illustration that reflects the Mitou Jr Mattermost channel updates for ${input.targetDateJst}. Make it illustration-first: communicate through cute scenes, expressive characters, icons, emojis, and simple diagrams, with only short Japanese headings and labels where needed. Preserve user names and channel names exactly as provided. Use the attached ずんだもん image as the character and style reference. Organize interesting and unique topics into clearly separated illustrated cards or scenes. Avoid paragraphs and dense text. Mattermost strings such as ":kusa:" are custom emojis; do not render the literal colon syntax. Replace them with a suitable visual symbol or omit them when unclear. Do not invent names, channel names, dates, or facts. Base the illustration only on this summary:\n${trimmed}`,
    size: "1792x1008",
    quality: "medium",
    output_format: "png",
  });
  const base64 = response.data?.[0]?.b64_json;
  if (!base64) throw new Error("OpenAI returned no image data");
  return {
    bytes: decodeBase64(base64),
    altText: `${input.targetDateJst}の未踏ジュニアMattermost投稿を、ずんだもんと共にまとめたインフォグラフィック`,
  };
}

function sanitizedOpenAiError(operation: string, error: unknown): Error {
  const candidate = error as {
    message?: unknown;
    status?: unknown;
    code?: unknown;
    cause?: { message?: unknown; cause?: { message?: unknown } };
  };
  const status = typeof candidate?.status === "number" ? ` status=${candidate.status}` : "";
  const code = typeof candidate?.code === "string" ? ` code=${candidate.code}` : "";
  const cause = typeof candidate?.cause?.cause?.message === "string"
    ? candidate.cause.cause.message
    : typeof candidate?.cause?.message === "string"
    ? candidate.cause.message
    : typeof candidate?.message === "string"
    ? candidate.message
    : "unknown error";
  return new Error(`OpenAI ${operation} failed.${status}${code} cause=${cause.slice(0, 240)}`);
}

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function currentTargetDate(target: SummaryTarget, now = new Date()): string {
  return summaryTimeRange(target, now).targetDateJst;
}
