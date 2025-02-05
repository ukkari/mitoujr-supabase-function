// supabase/functions/today-channels-summary/index.ts

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import OpenAI from "https://deno.land/x/openai@v4.69.0/mod.ts";
import * as cheerio from "https://esm.sh/cheerio@1.0.0-rc.12";
import { getReactions } from "../_shared/mattermost.ts";

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

    console.log("Fetching channels...");
    const channels = await fetchPublicChannels(MATTERMOST_MAIN_TEAM);
    console.log("Channels fetched:", channels);
    if (!channels) {
      return new Response(JSON.stringify({ error: "Failed to fetch channels" }), { status: 500 });
    }
    
    console.log("Filtering channels updated yesterday...");
    const updatedYesterday = channels.filter((ch) =>
      ch.type === "O" &&
      ch.last_post_at >= startOfYesterdayUTC_inMillis &&
      //ch.last_post_at < endOfYesterdayUTC_inMillis &&
      ch.id !== MATTERMOST_SUMMARY_CHANNEL &&
      !ch.display_name.toLowerCase().includes('notification')
    );
    console.log("Channels updated yesterday:", updatedYesterday);
    
    let summaryRaw = "";
    for (const ch of updatedYesterday) {
      const channelLink = `[${ch.display_name}](${MATTERMOST_URL}/mitoujr/channels/${ch.name})`;
      const channelId = ch.id;
    
      console.log(`Fetching posts for channel: ${ch.display_name}`);
      const yesterdaysPosts = await fetchPostsInRange(channelId, startOfYesterdayUTC_inMillis, endOfYesterdayUTC_inMillis);
      console.log(`Posts fetched for channel ${ch.display_name}:`, yesterdaysPosts);
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
    
    console.log("Summary raw content:", summaryRaw);
    
    if (!summaryRaw.trim()) {
      await postToMattermost("昨日は更新がありませんでした。");
      return new Response(JSON.stringify({ message: "No updates yesterday" }), { status: 200 });
    }
    
    console.log("Preparing OpenAI summarization prompt...");
    const promptUser = `ずんだもんとして、昨日のMattermost投稿について、全体の概要のあとに、チャンネルごとにまとめてください。(入室メッセージしかなかったチャンネルを除く)
    
    ** ステップ **
    1. 全体の投稿概要を最初にまとめて表示してください。読む人がワクワクするように、絵文字も含めて、プロとして面白いまとめにしてください。
    2. 続いて、更新があったチャンネルごとに、誰からどのような投稿があったのかを絵文字も使ってポップにまとめて。
    - 決して、すべての投稿を羅列しないでください。
    - もし、チャンネルに「が入室しました」のような誰かが入室したことを示すシステムメッセージの投稿しかなかった場合は、チャンネル自体をまとめに含めないでください。
    - 「が入室しました」のようなMattermostのシステムメッセージは、まとめに含めないでください。
    - emoji がリアクションに使われていたら、うまくそれもまとめに含めてください。
    3. 最後にかならず、「今日一番おもしろかったチャンネル」を選んで、「ずんだもん」として表彰してください。なにが面白かったのか、今後どんな投稿があるといいのかに言及しつつ「ずんだもん」として落としてください。
    
    ** 全体の指示 **
    - Mattermostのポストやチャンネルへのリンクは、必ず以下のフォーマットを使ってリンクをしてください。
    [z-times-hara](https://mattermost.jr.mitou.org/mitoujr/channels/z-times-hara)
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
    
    ${summaryRaw}`;
    
    console.log("Calling OpenAI API...");
    const completion = await openai.chat.completions.create({
      model: "chatgpt-4o-latest",
      messages: [
        { role: "system", content: "You are a helpful assistant summarizing multiple posts on Mattermost channel." },
        { role: "user", content: promptUser },
      ],
    });
    
    const gptText = completion.choices[0]?.message?.content ?? "(No response from OpenAI)";
    
    console.log("OpenAI response:", gptText);
    await postToMattermost(gptText);
    
    console.log("Posting summary to Mattermost...");
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

/**
 * 指定した channelId 内の投稿を startUTC～endUTC の間で取得し、
 * 各投稿で検出した外部URLの OGP 情報をメッセージ本文に追記しつつ、
 * さらに「誰がどんな絵文字をつけたか」を取得して格納します。
 */
export async function fetchPostsInRange(
  channelId: string,
  startUTC: number,
  endUTC: number
): Promise<any[]> {
  try {
    console.log(`Fetching posts in range for channel: ${channelId}`);
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
      console.log("No posts found in response data.");
      return [];
    }

    const postIds: string[] = data.order || [];
    const postsObj = data.posts;

    // 範囲内 (startUTC <= create_at < endUTC) でフィルタ
    const result: any[] = [];
    for (const pid of postIds) {
      const p = postsObj[pid];
      if (p && p.create_at >= startUTC && p.create_at < endUTC) {
        console.log(`Processing post: ${p.id}`);

        // ----- 追記: 各投稿のリアクション情報を取得し、p.message の末尾に追記 -----
        try {
          console.log(`Fetching reactions for post: ${p.id}`);
          const reactions = await getReactions(p.id);
          if (reactions.length > 0) {
            // それぞれのリアクションについてユーザ名を取得して文字列を作成
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

    // 古い→新しい順にソート
    result.sort((a, b) => a.create_at - b.create_at);
    console.log("Posts processed and sorted.");
    return result;
  } catch (err) {
    console.error("[fetchPostsInRange] error:", err);
    return [];
  }
}