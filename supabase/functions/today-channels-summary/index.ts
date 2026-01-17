import { Hono } from "https://deno.land/x/hono@v3.12.4/mod.ts";
import { cors } from "https://deno.land/x/hono@v3.12.4/middleware.ts";
import {
  fetchPostsInRange,
  fetchPublicChannels,
  fetchUserName,
  formatChannelLink,
  postToMattermost,
  postMessageWithImage,
  MATTERMOST_SUMMARY_CHANNEL,
} from "./services/mattermost.ts";
import { generateTextSummary } from "./services/summarizer.ts";
import { generateAudioSummary } from "./services/audio.ts";
import { generateSummaryImage, type SummaryImage } from "./services/vision.ts";
import {
  getDebugLogs,
  restoreConsole,
  setupDebugLogging,
} from "./utils/logger.ts";

const MATTERMOST_MAIN_TEAM = Deno.env.get("MATTERMOST_MAIN_TEAM") ?? "";
const app = new Hono();

app.use("*", cors());

app.options("*", (c) => c.text("", 204));

app.all("/*", handler);

async function handler(c: any) {
  const debug = c.req.query("debug") === "true";
  const forToday = c.req.query("forToday") === "true";
  const type = c.req.query("type") ?? "text";
  const lang = (c.req.query("lang") ?? "ja-JP") as "ja-JP" | "en-US";
  const engine = c.req.query("engine") ?? "gemini";

  setupDebugLogging(debug);

  try {
    const { startTimeUTC, endTimeUTC, timeRangeDescription, dateLabelJST } =
      getTimeRange(forToday);
    console.log(
      `Request parameters: debug=${debug}, forToday=${forToday}, type=${type}, lang=${lang}, engine=${engine}`,
    );
    console.log(
      `Time range: ${new Date(startTimeUTC).toISOString()} to ${new Date(endTimeUTC).toISOString()}`,
    );

    const channels = await fetchPublicChannels(MATTERMOST_MAIN_TEAM);
    if (!channels) {
      return c.json({ error: "Failed to fetch channels" }, 500);
    }

    if (debug) {
      console.log(
        `[debug] fetched channels (${channels.length} total):`,
        channels.map((ch: any) => ({
          id: ch.id,
          name: ch.name,
          display_name: ch.display_name,
          type: ch.type,
          last_post_at: ch.last_post_at,
        })),
      );
    }

    const updatedChannels = channels.filter((ch) =>
      ch.type === "O" &&
      ch.last_post_at >= startTimeUTC &&
      ch.id !== MATTERMOST_SUMMARY_CHANNEL &&
      !ch.display_name.toLowerCase().includes("notification")
    );

    if (debug) {
      console.log(
        `[debug] channels after filter (${updatedChannels.length} total):`,
        updatedChannels.map((ch: any) => ({
          id: ch.id,
          name: ch.name,
          display_name: ch.display_name,
          type: ch.type,
          last_post_at: ch.last_post_at,
        })),
      );
    }

    console.log(
      `Channels updated ${timeRangeDescription}: ${updatedChannels.length}`,
    );

    let summaryRaw = "";

    for (const ch of updatedChannels) {
      const posts = await fetchPostsInRange(
        ch.id,
        startTimeUTC,
        endTimeUTC,
      );

      if (posts.length === 0) continue;

      summaryRaw += `\n【チャンネル】${formatChannelLink(ch.display_name, ch.name)}\n`;
      for (const p of posts) {
        const cleanMessage = removeMentions(p.message);
        const userName = await fetchUserName(p.user_id);
        summaryRaw += `  - ${userName}: ${cleanMessage}\n`;
      }
      summaryRaw += "\n";
    }

    if (!summaryRaw.trim()) {
      console.log("No summary content generated.");
      await postNoUpdates(timeRangeDescription);
      return c.json({ message: `No updates ${timeRangeDescription}` });
    }

    if (type === "audio") {
      const { audioUrl, script } = await generateAudioSummary({
        summaryRaw,
        timeRangeDescription,
        lang,
        engine,
      });

      if (!debug) {
        await postAudioSummary(timeRangeDescription, audioUrl, lang, engine);
      }

      return c.json({
        message: debug
          ? "Debug mode: Generated audio without posting"
          : `Posted ${timeRangeDescription}'s channel audio summary.`,
        audioUrl,
        language: lang,
        engine,
        ...(debug && { logs: getDebugLogs(), script }),
      });
    } else {
      const gptText = await generateTextSummary(summaryRaw, timeRangeDescription);

      let imageResult: SummaryImage | null = null;
      try {
        console.log("Attempting Gemini image generation for summary");
        imageResult = await generateSummaryImage(
          gptText,
          timeRangeDescription,
          dateLabelJST,
        );
        if (imageResult?.imageBytes) {
          console.log(
            "Generated summary image",
            {
              byteLength: imageResult.imageBytes.length,
              altTextPreview: imageResult.altText?.slice(0, 80) ?? "",
            },
          );
        } else {
          console.log("Gemini returned no image; will fall back to text only.");
        }
      } catch (imageErr) {
        console.error("Failed to generate image with Gemini:", imageErr);
      }

      if (!debug) {
        if (imageResult?.imageBytes) {
          await postMessageWithImage(gptText, imageResult.imageBytes, {
            altText: imageResult.altText,
          });
          console.log("Posted summary with image to Mattermost");
        } else {
          await postTextSummary(gptText);
          console.log("Posted text-only summary to Mattermost");
        }
      }

      return c.json({
        message: debug
          ? "Debug mode: Generated summary without posting"
          : `Posted ${timeRangeDescription}'s channel summary.`,
        summary: gptText,
        ...(debug && {
          image: imageResult
            ? {
              hasImage: true,
              altText: imageResult.altText,
              byteLength: imageResult.imageBytes.length,
            }
            : { hasImage: false },
          logs: getDebugLogs(),
        }),
      });
    }
  } catch (err) {
    console.error("today-channels-summary error:", err);
    return c.json(
      {
        error: err?.message ?? "Unknown error",
        ...(debug && { logs: getDebugLogs() }),
      },
      500,
    );
  } finally {
    restoreConsole();
  }
}

function getTimeRange(forToday: boolean) {
  const nowUTC = new Date();
  const jstOffset = 9 * 60 * 60 * 1000;
  const nowJST = new Date(nowUTC.getTime() + jstOffset);
  const startOfTodayJST = new Date(
    nowJST.getFullYear(),
    nowJST.getMonth(),
    nowJST.getDate(),
    0,
    0,
    0,
    0,
  );
  const endOfYesterdayUTC = startOfTodayJST.getTime() - jstOffset;

  const startOfYesterdayJST = new Date(
    nowJST.getFullYear(),
    nowJST.getMonth(),
    nowJST.getDate() - 1,
    0,
    0,
    0,
    0,
  );
  const startOfYesterdayUTC = startOfYesterdayJST.getTime() - jstOffset;

  const startTimeUTC = forToday ? endOfYesterdayUTC : startOfYesterdayUTC;
  const endTimeUTC = forToday ? Date.now() : endOfYesterdayUTC;
  const timeRangeDescription = forToday ? "今日" : "昨日";
  const dateLabelJST = forToday
    ? formatDateJST(startOfTodayJST)
    : formatDateJST(startOfYesterdayJST);

  return { startTimeUTC, endTimeUTC, timeRangeDescription, dateLabelJST };
}

function formatDateJST(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = `${date.getMonth() + 1}`.padStart(2, "0");
  const dd = `${date.getDate()}`.padStart(2, "0");
  return `${yyyy}-${mm}-${dd} (JST)`;
}

function removeMentions(text: string): string {
  return text.replace(/@([a-zA-Z0-9._-]+)/g, "$1");
}

async function postNoUpdates(timeRangeDescription: string) {
  await postToMattermost(`${timeRangeDescription}は更新がありませんでした。`);
}

async function postAudioSummary(
  timeRangeDescription: string,
  audioUrl: string,
  lang: "ja-JP" | "en-US",
  engine: string,
) {
  const title = engine === "voicevox"
    ? `:zundamon: ずんだもんのチャンネルサマリー（音声版）なのだ！\n${audioUrl}`
    : lang === "ja-JP"
    ? `チャンネルサマリー（音声版・日本語）\n${audioUrl}`
    : `Channel Summary (Audio Version - English)\n${audioUrl}`;

  await postToMattermost(title);
  console.log(
    `Posted ${engine} ${lang} audio summary for ${timeRangeDescription}`,
  );
}

async function postTextSummary(gptText: string) {
  await postToMattermost(gptText);
  console.log("Posted summary to Mattermost");
}

Deno.serve(app.fetch);
