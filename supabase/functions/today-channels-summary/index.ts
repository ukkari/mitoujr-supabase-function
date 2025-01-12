// supabase/functions/today-channels-summary/index.ts

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import OpenAI from "https://deno.land/x/openai@v4.69.0/mod.ts";

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

    // （1）チャンネル一覧を取得
    const channels = await fetchPublicChannels(MATTERMOST_MAIN_TEAM);
    if (!channels) {
      return new Response(JSON.stringify({ error: "Failed to fetch channels" }), { status: 500 });
    }

    // （2）JSTで「今日の0時」を求める
    // サーバー時刻がUTCの場合、Date() はUTCベース
    // JST(UTC+9)の「今日0時」を得るため:
    const nowUTC = new Date();
    // nowUTC から日本時間における「日付・月・年」を取り出すには、+9時間した日時を作り出し、
    // その年/月/日を使ってあらためてUTCに変換すると「JSTの0時(UTCでは前日15時)」が得られる。
    const jstOffset = 9 * 60 * 60 * 1000; // 9時間
    const nowJST = new Date(nowUTC.getTime() + jstOffset);
    const startOfDayJST = new Date(
      nowJST.getFullYear(), 
      nowJST.getMonth(),
      nowJST.getDate(),
      0, 0, 0, 0
    );
    // startOfDayJST はローカルタイム(コンストラクタ)なので、ミリ秒にすると「日本時間で0時」のローカルtimestamp
    // UTCでのエポックに合わせたい場合は再度 getTime() - jstOffset してもOKだが、
    // ポスト作成時間と比較するには「create_at」(Unixエポックms, UTC相当)に合わせて計算したほうがシンプル。
    // ここではシンプルに「startOfDayUTC_inMillis = startOfDayJST.getTime() - jstOffset」とする:
    const startOfDayUTC_inMillis = startOfDayJST.getTime() - jstOffset;

    // （3）"今日更新があった" チャンネルをフィルタ last_post_at >= startOfDayUTC_inMillis
    const updatedToday = channels.filter(
        (ch) =>
          ch.type === "O" &&
          ch.last_post_at >= startOfDayUTC_inMillis &&
          ch.id !== MATTERMOST_SUMMARY_CHANNEL // ここを追加
      );
      

    // （4） チャンネルごとに「今日のポスト」を取得 → 文字列まとめ
    let summaryRaw = ""; // OpenAIに投げる前の生データ
    for (const ch of updatedToday) {
      // チャンネルへのリンク
      // Mattermostでは URL/{team_id}/channels/{channel.name} 形式が多い
      const channelLink = `[${ch.display_name}](${MATTERMOST_URL}/mitoujr/channels/${ch.name})`;
      const channelId = ch.id;

      // 今日のポスト一覧を取得
      const todaysPosts = await fetchTodaysPosts(channelId, startOfDayUTC_inMillis);
      if (todaysPosts.length === 0) {
        continue;
      }

      // 見出し (リンク形式)
      summaryRaw += `\n【チャンネル】${channelLink}\n`;

      // 各ポストを列挙
      for (const p of todaysPosts) {
        // ユーザーIDやユーザー名をここで取得するには、追加のAPI呼び出しが必要
        // サンプルでは p.user_id だけあるが "誰が" の部分は user_id 表記か簡単に user_id を載せる想定
        // mention (@xxxx)を無効化 => "@xxxx" を全部 "xxxx" に置換
        const cleanMessage = removeMentions(p.message);

        // 時刻をJST表示に変換
        const jstTimeString = toJSTString(p.create_at);
        const userName = await fetchUserName(p.user_id)
        summaryRaw += `  - ${userName} (${jstTimeString}): ${cleanMessage}\n`
      }
      summaryRaw += "\n"; // 改行
    }

    if (!summaryRaw.trim()) {
      // 今日更新があった投稿が何もない場合
      await postToMattermost("今日は更新がありませんでした。");
      return new Response(JSON.stringify({ message: "No updates today" }), { status: 200 });
    }

    // (5) OpenAI で整形
    const promptUser = `Mattermostの各チャンネルに投稿された情報をまとめたいです。
    - 冒頭に、日付と、全体としてどんな投稿があったのかをまとめてください。
    - それぞれの更新があったチャンネルについて、誰がどのような投稿をしたのか、簡単にまとめてください。
    - Mattermostの各チャンネルへのリンクは、そのまま残してください。
    \n\n${summaryRaw}`;
    
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: promptUser },
      ],
    });

    const gptText = completion.choices[0]?.message?.content ?? "(OpenAI からの応答を取得できませんでした)";

    // (6) Mattermostに投稿 (OpenAI整形済み)
    await postToMattermost(gptText);

    return new Response(
      JSON.stringify({ message: "Posted today's channel summary." }),
      { status: 200 },
    );
  } catch (err) {
    console.error("today-channels-summary error:", err);
    return new Response(JSON.stringify({ error: err?.message }), { status: 500 });
  }
});

/** Mention (@xxx) を削除するための関数 */
function removeMentions(text: string): string {
  // 例: "@abc" を "abc" に置換
  // "@abc-def" なども想定
  return text.replace(/@([a-zA-Z0-9._\-]+)/g, "$1");
}

/** UTCエポックms を JST表示に変換 */
function toJSTString(utcMillis: number): string {
  // JSTはUTC+9時間
  const jst = new Date(utcMillis + 9 * 60 * 60 * 1000);
  // 日本時間でロケール表示
  return jst.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
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