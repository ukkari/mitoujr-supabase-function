// supabase/functions/today-channels-summary/index.ts

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import OpenAI from "https://deno.land/x/openai@v4.69.0/mod.ts";
import * as cheerio from "https://esm.sh/cheerio@1.0.0-rc.12";

/** 環境変数 */
const MATTERMOST_URL = Deno.env.get("MATTERMOST_URL") ?? "";
const MATTERMOST_BOT_TOKEN = Deno.env.get("MATTERMOST_BOT_TOKEN") ?? "";
const MATTERMOST_MAIN_TEAM = Deno.env.get("MATTERMOST_MAIN_TEAM") ?? "";
const MATTERMOST_SUMMARY_CHANNEL = Deno.env.get("MATTERMOST_SUMMARY_CHANNEL") ?? "";

/** OpenAI API キー (GPT-4) */
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";

// OpenAIクライアント初期化
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

/**
 * このEdge Functionが呼ばれたら以下を行う:
 *  1. メインチーム内のチャンネル一覧(パブリック)を取得
 *  2. 今日(午前0時JST以降)更新があったチャンネルだけ抽出
 *  3. 該当チャンネルの「今日のポスト」を取得
 *  4. 全ポストをまとめ、OpenAI APIで整形
 *  5. Mattermostに投稿
 *
 * 実行はSupabase Scheduler等で1日1回(または任意時間)に呼び出す想定
 */
serve(async (req) => {
  try {
    // CORS対応 (必要なら)
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204 });
    }

    // 1. Figure out “today’s” start (for end of yesterday)
    const nowUTC = new Date();
    const jstOffset = 9 * 60 * 60 * 1000;
    const nowJST = new Date(nowUTC.getTime() + jstOffset);
    const startOfTodayJST = new Date(
      nowJST.getFullYear(),
      nowJST.getMonth(),
      nowJST.getDate(),
      0, 0, 0, 0
    );
    const endOfYesterdayUTC_inMillis = startOfTodayJST.getTime() - jstOffset;

    // 2. Figure out “yesterday’s” start
    // (subtract 1 from the date)
    const startOfYesterdayJST = new Date(
      nowJST.getFullYear(),
      nowJST.getMonth(),
      nowJST.getDate() - 1,
      0, 0, 0, 0
    );
    const startOfYesterdayUTC_inMillis = startOfYesterdayJST.getTime() - jstOffset;

    // Fetch channels
    const channels = await fetchPublicChannels(MATTERMOST_MAIN_TEAM);
    if (!channels) {
      return new Response(JSON.stringify({ error: "Failed to fetch channels" }), { status: 500 });
    }

    // Filter for channels updated “yesterday”
    const updatedYesterday = channels.filter((ch) =>
      ch.type === "O" &&
      ch.last_post_at >= startOfYesterdayUTC_inMillis &&
      //ch.last_post_at < endOfYesterdayUTC_inMillis &&
      ch.id !== MATTERMOST_SUMMARY_CHANNEL &&
      !ch.display_name.toLowerCase().includes('notification')
    );

    let summaryRaw = "";
    for (const ch of updatedYesterday) {
      const channelLink = `[${ch.display_name}](${MATTERMOST_URL}/mitoujr/channels/${ch.name})`;
      const channelId = ch.id;

      // Fetch posts between these two times
      const yesterdaysPosts = await fetchPostsInRange(channelId, startOfYesterdayUTC_inMillis, endOfYesterdayUTC_inMillis);
      if (yesterdaysPosts.length === 0) {
        continue;
      }

      summaryRaw += `\n【チャンネル】${channelLink}\n`;
      for (const p of yesterdaysPosts) {
        const cleanMessage = removeMentions(p.message);
        const userName = await fetchUserName(p.user_id);
        summaryRaw += `  - ${userName}: ${cleanMessage}\n`;
      }
      summaryRaw += "\n";
    }

    console.log(summaryRaw);

    if (!summaryRaw.trim()) {
      await postToMattermost("昨日は更新がありませんでした。");
      return new Response(JSON.stringify({ message: "No updates yesterday" }), { status: 200 });
    }

    // OpenAI summarization prompt
    const promptUser = `昨日のMattermost投稿を、チャンネルごとにまとめてください。
- 昨日の日付と、全体の投稿概要を最初にまとめて表示してください。読む人がワクワクするように、絵文字も含めて、プロとして面白いまとめにしてください。
- 続いて、更新があったチャンネルごとに、誰からどのような投稿があったのかをまとめて。決して、すべての投稿を羅列しないでください。
- もし、チャンネルに「が入室しました」という投稿しかなかった場合は、チャンネルをまとめに含めないでください。
- 「が入室しました」のようなMattermostのシステムメッセージは、まとめに含めないでください。
- 最後にかならず、「今日一番おもしろかったチャンネル」を選んで、表彰してください。
- Mattermostのポストやチャンネルへのリンクは、必ず以下のフォーマットを使ってリンクをしてください。
[z-times-hara](https://mattermost.jr.mitou.org/mitoujr/channels/z-times-hara)

${summaryRaw}`;

    const completion = await openai.chat.completions.create({
      model: "o1",
      messages: [
        { role: "system", content: "You are a helpful assistant summarizing multiple posts on Mattermost channel." },
        { role: "user", content: promptUser },
      ],
    });

    const gptText = completion.choices[0]?.message?.content ?? "(No response from OpenAI)";
    
    console.log(gptText);
    await postToMattermost(gptText);

    return new Response(JSON.stringify({ message: "Posted yesterday's channel summary." }), {
      status: 200,
    });
  } catch (err) {
    console.error("yesterday-channels-summary error:", err);
    return new Response(JSON.stringify({ error: err?.message }), { status: 500 });
  }
});

/** Mention (@xxx) を削除するための関数 */
function removeMentions(text: string): string {
  // 例: "@abc" を "abc" に置換
  // "@abc-def" なども想定
  return text.replace(/@([a-zA-Z0-9._\-]+)/g, "$1");
}

/** Mattermost API (GET) でチャンネル一覧(パブリック)を取得 */
async function fetchPublicChannels(teamId: string): Promise<any[] | null> {
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

/**
 * 指定した channel_id から /api/v4/channels/{channel_id}/posts を取得し、
 * create_at >= startOfDayUTC_inMillis のものを返す。
 */
async function fetchTodaysPosts(
  channelId: string,
  startOfDayUTC_inMillis: number,
): Promise<any[]> {
  try {
    const url = `${MATTERMOST_URL}/api/v4/channels/${channelId}/posts?per_page=200`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${MATTERMOST_BOT_TOKEN}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      console.error("[fetchTodaysPosts] failed", await res.text());
      return [];
    }

    const data = await res.json();
    if (!data.posts) {
      return [];
    }

    // posts は { id: Post } のオブジェクト、 order は postのID配列
    const postIds: string[] = data.order || [];
    const postsObj = data.posts;

    // create_at >= startOfDayUTC_inMillis のものだけを抽出
    const result: any[] = [];
    for (const pid of postIds) {
      const p = postsObj[pid];
      if (p && p.create_at >= startOfDayUTC_inMillis) {
        result.push(p);
      }
    }
    // 時系列順(古い→新しい)に並べたいなら sort
    result.sort((a, b) => a.create_at - b.create_at);

    return result;
  } catch (err) {
    console.error("[fetchTodaysPosts] error:", err);
    return [];
  }
}

/** Mattermost に投稿する (投稿先チャンネルは MATTERMOST_SUMMARY_CHANNEL) */
async function postToMattermost(message: string): Promise<void> {
  if (!MATTERMOST_SUMMARY_CHANNEL) {
    console.warn("MATTERMOST_SUMMARY_CHANNEL is not set. Skipping post.");
    return;
  }

  const url = `${MATTERMOST_URL}/api/v4/posts`;
  const body = {
    channel_id: MATTERMOST_SUMMARY_CHANNEL,
    message,
  };
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

// ユーザID→username のキャッシュ用
const userNameCache: Record<string, string> = {}

/** 指定ユーザIDの username を取得 (キャッシュ込み) */
async function fetchUserName(userId: string): Promise<string> {
  // キャッシュ済みなら再リクエストしない
  if (userNameCache[userId]) {
    return userNameCache[userId]
  }

  const url = `${MATTERMOST_URL}/api/v4/users/${userId}`
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${MATTERMOST_BOT_TOKEN}`,
      Accept: 'application/json',
    }
  })
  if (!res.ok) {
    console.error(`[fetchUserName] Failed to fetch user data for ${userId}`, await res.text())
    // ユーザ取得失敗したら "unknown" として返す
    userNameCache[userId] = "unknown"
    return "unknown"
  }

  const data = await res.json()
  // data.username をキャッシュ
  userNameCache[userId] = data.username || "unknown"

  return userNameCache[userId]
}

// Example modified fetchPostsInRange function
async function fetchPostsInRange(
  channelId: string,
  startUTC: number,
  endUTC: number
): Promise<any[]> {
  try {
    const url = `${MATTERMOST_URL}/api/v4/channels/${channelId}/posts?per_page=200`;
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
      return [];
    }

    const postIds: string[] = data.order || [];
    const postsObj = data.posts;

    // Filter by >= startUTC AND < endUTC
    const result: any[] = [];
    for (const pid of postIds) {
      const p = postsObj[pid];
      if (p && p.create_at >= startUTC && p.create_at < endUTC) {
        // 外部URLを検出（MATTERMOST_URLを除く）
        const urls = (p.message.match(/https?:\/\/[^\s]+/g) || [])
          .filter(url => !url.startsWith(MATTERMOST_URL));
        
        if (urls.length > 0) {
          try {
            const response = await fetch(urls[0]);
            const html = await response.text();
            const $ = cheerio.load(html);
            
            // OGPの説明を取得
            const ogDescription = $('meta[property="og:description"]').attr('content');
            const ogTitle = $('meta[property="og:title"]').attr('content');
            
            if (ogDescription || ogTitle) {
              const ogInfo = [];
              if (ogTitle) ogInfo.push(ogTitle);
              if (ogDescription) ogInfo.push(ogDescription);
              p.message = `${p.message}\n> (${ogInfo.join(' - ')})`;
            }
          } catch (error) {
            console.warn(`Failed to fetch OGP for URL: ${urls[0]}`, error);
          }
        }
        
        result.push(p);
      }
    }
    result.sort((a, b) => a.create_at - b.create_at);
    return result;
  } catch (err) {
    console.error("[fetchPostsInRange] error:", err);
    return [];
  }
}