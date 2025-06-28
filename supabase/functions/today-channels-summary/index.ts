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

// Store logs when in debug mode
let debugLogs: string[] = [];

// Override console.log in debug mode
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

function setupDebugLogging(debug: boolean) {
  debugLogs = [];
  if (debug) {
    console.log = (...args) => {
      debugLogs.push(args.map(arg => 
        typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
      ).join(' '));
      originalConsoleLog.apply(console, args);
    };
    console.error = (...args) => {
      debugLogs.push('[ERROR] ' + args.map(arg => 
        typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
      ).join(' '));
      originalConsoleError.apply(console, args);
    };
  } else {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  }
}

// OpenAIクライアント初期化
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// Available voices for audio generation
const AVAILABLE_VOICES = [
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda',
  'Orus', 'Aoede', 'Callirhoe', 'Autonoe', 'Enceladus', 'Iapetus',
  'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi',
  'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima',
  'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafar'
];

// Function to get random voices
function getRandomVoices(): [string, string] {
  const shuffled = [...AVAILABLE_VOICES].sort(() => Math.random() - 0.5);
  return [shuffled[0], shuffled[1]];
}

/**
 * このEdge Functionが呼ばれたら以下を行う:
 *  1. メインチーム内のチャンネル一覧(パブリック)を取得
 *  2. 今日または昨日(午前0時JST以降)更新があったチャンネルだけ抽出
 *  3. 該当チャンネルの「今日または昨日のポスト」を取得
 *  4. 全ポストをまとめ、OpenAI APIで整形
 *  5. Mattermostに投稿
 *
 * 実行はSupabase Scheduler等で1日1回(または任意時間)に呼び出す想定
 */
serve(async (req) => {
  try {
    const url = new URL(req.url);
    const debug = url.searchParams.get('debug') === 'true';
    const forToday = url.searchParams.get('forToday') === 'true';
    const type = url.searchParams.get('type') || 'text'; // デフォルトはtext
    const lang = (url.searchParams.get('lang') || 'ja-JP') as 'ja-JP' | 'en-US'; // デフォルトはja-JP
    
    console.log(`Request parameters: debug=${debug}, forToday=${forToday}, type=${type}, lang=${lang}`);
    
    // Setup debug logging if needed
    setupDebugLogging(debug);

    // CORS対応 (必要なら)
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204 });
    }

    // 1. Figure out "today's" start (for end of yesterday)
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

    // 2. Figure out "yesterday's" start
    // (subtract 1 from the date)
    const startOfYesterdayJST = new Date(
      nowJST.getFullYear(),
      nowJST.getMonth(),
      nowJST.getDate() - 1,
      0, 0, 0, 0
    );
    const startOfYesterdayUTC_inMillis = startOfYesterdayJST.getTime() - jstOffset;

    // Determine the time range based on forToday parameter
    const startTimeUTC_inMillis = forToday ? endOfYesterdayUTC_inMillis : startOfYesterdayUTC_inMillis;
    const endTimeUTC_inMillis = forToday ? Date.now() : endOfYesterdayUTC_inMillis;
    const timeRangeDescription = forToday ? "今日" : "昨日";
    
    console.log(`Time range: ${new Date(startTimeUTC_inMillis).toISOString()} to ${new Date(endTimeUTC_inMillis).toISOString()}`);

    console.log("Fetching channels...");
    const channels = await fetchPublicChannels(MATTERMOST_MAIN_TEAM);
    console.log("Channels fetched:", channels?.length || 0, "channels");
    if (!channels) {
      return new Response(JSON.stringify({ error: "Failed to fetch channels" }), { status: 500 });
    }
    
    console.log(`Filtering channels updated ${timeRangeDescription}...`);
    console.log(`Filter criteria: type=O, last_post_at>=${startTimeUTC_inMillis}, id!=${MATTERMOST_SUMMARY_CHANNEL}`);
    const updatedChannels = channels.filter((ch) =>
      ch.type === "O" &&
      ch.last_post_at >= startTimeUTC_inMillis &&
      ch.id !== MATTERMOST_SUMMARY_CHANNEL &&
      !ch.display_name.toLowerCase().includes('notification')
    );
    console.log(`Channels updated ${timeRangeDescription}:`, updatedChannels.length, "channels");
    updatedChannels.forEach(ch => console.log(`  - ${ch.display_name} (${ch.name})`));
    
    let summaryRaw = "";
    console.log("Starting to process channels...");
    for (const ch of updatedChannels) {
      const channelLink = `[${ch.display_name}](${MATTERMOST_URL}/mitoujr/channels/${ch.name})`;
      const channelId = ch.id;
      
      // チャンネルが制限されているかチェック
      console.log(`Checking if channel ${ch.display_name} is restricted...`);
      const isRestricted = await isRestrictedChannel(channelId);
      if (isRestricted) {
        console.log(`Channel ${ch.display_name} is restricted. Skipping.`);
        continue;
      }
    
      console.log(`Fetching posts for channel: ${ch.display_name} (${channelId})`);
      const posts = await fetchPostsInRange(channelId, startTimeUTC_inMillis, endTimeUTC_inMillis);
      console.log(`Posts fetched for channel ${ch.display_name}:`, posts.length, "posts");
      if (posts.length === 0) {
        console.log(`No posts found for channel ${ch.display_name}. Skipping.`);
        continue;
      }
    
      console.log(`Adding ${posts.length} posts from ${ch.display_name} to summary...`);
      summaryRaw += `\n【チャンネル】${channelLink}\n`;
      for (const p of posts) {
        const cleanMessage = removeMentions(p.message);
        const userName = await fetchUserName(p.user_id);
        summaryRaw += `  - ${userName}: ${cleanMessage}\n`;
      }
      summaryRaw += "\n";
    }
    
    console.log("All channels processed.");
    console.log("Summary raw content length:", summaryRaw.length, "characters");
    console.log("Summary raw content:", summaryRaw);
    
    if (!summaryRaw.trim()) {
      console.log("No summary content generated. Posting 'no updates' message...");
      await postToMattermost(`${timeRangeDescription}は更新がありませんでした。`);
      return new Response(JSON.stringify({ message: `No updates ${timeRangeDescription}` }), { status: 200 });
    }
    
    if (type === 'audio') {
      // 音声生成処理
      console.log("Type is 'audio'. Starting audio generation process...");
      console.log("Processing audio generation...");
      
      console.log("Preparing OpenAI summarization prompt...");
      const getAudioPrompt = (language: 'ja-JP' | 'en-US') => {
        const isJapanese = language === 'ja-JP';
        
        // Language-specific phrases
        const phrases = {
          opening: isJapanese 
            ? "皆さんおはようございます！未踏ジュニアポッドキャストへようこそ！" 
            : "Good morning everyone! Welcome to the Mitou Junior Podcast!",
          affirmations: isJapanese
            ? '"そうですね" "たしかに" "ほんそれ" and "ほんとうにそう！"'
            : '"absolutely" "exactly" "totally" and "so true!"',
          rhetorical: isJapanese
            ? "これ面白くないですか？"
            : "Isn't this fascinating?",
          fillers: isJapanese
            ? '"えーっと" and "なんていうか" "えー" "あのー"'
            : '"um" and "you know" "well" "so"',
          naturalizing: isJapanese
            ? 'natural in Japanese like "のチャンネル" "さんによると"'
            : 'natural in English like "in the X channel" "according to X"',
          analogy: isJapanese
            ? "まるで XXX みたい！"
            : "It's like XXX!",
          validation: isJapanese
            ? "いやー、わかってますね"
            : "wow, you really get it",
          audience: isJapanese
            ? "今聞いている未踏ジュニアのみなさんも"
            : "For those of you listening from Mitou Junior",
          summarize: isJapanese
            ? "まとめると"
            : "to sum it up",
          wrapUp: isJapanese
            ? "そろそろ時間なんですが"
            : "We're running out of time, but",
          transition: isJapanese
            ? "じゃあ"
            : "so",
          encourage: isJapanese
            ? "未踏ジュニアのコミュニティを一緒に盛り上げていきましょう"
            : "Let's keep building this amazing Mitou Junior community together",
          ending: isJapanese
            ? "明日は XXX な話があるのか、楽しみですね。"
            : "I can't wait to see what exciting discussions we'll have tomorrow.",
          speaker1: isJapanese
            ? "皆さん、こんにちは！未踏ジュニアポッドキャストへようこそ！"
            : "Good morning everyone! Welcome to the Mitou Junior Podcast!",
          speaker2: isJapanese
            ? "いや〜、今日も始まりましたね！"
            : "Oh wow, here we go again!",
          community: isJapanese
            ? "未踏ジュニアコミュニティ"
            : "Mitou Junior Community",
          projectName: isJapanese
            ? "未踏ジュニア"
            : "Mitou Junior"
        };
        
        return `      
You're going to create a podcast based for ${phrases.community} on the chat log of ${phrases.projectName} ${timeRangeDescription} shared below.

Opening:
– Begin with a welcoming phrase: "${phrases.opening}" 

Dialog Structure:
– Use two hosts (Speaker 1 and Speaker 2) who engage in a conversational back-and-forth.
– Alternate between short, punchy statements and longer explanations.
– Use frequent affirmations like ${phrases.affirmations} to maintain flow and agreement.

Language and Tone:
– Keep the language informal and accessible. Use contractions and colloquialisms.
– Maintain an enthusiastic, energetic tone throughout.
– Use rhetorical questions to transition between points: "${phrases.rhetorical}"
– Employ phrases like ${phrases.fillers} to maintain a casual feel.

Content Presentation:
– Always clearly mention a channel name, and user name in the discussion as the goal of the podcast to help users understand who said what where. 
- Do not use the raw channel names and user names. Make it more ${phrases.naturalizing}
– Use analogies to explain complex concepts: "${phrases.analogy}"
– Break down ideas into digestible chunks, often using numbered points or clear transitions.

Interaction Between Hosts:
– Have one host pose questions or express confusion, allowing the other to explain.
– Use phrases like "${phrases.validation}" to validate each other's points.
– Build on each other's ideas, creating a collaborative feel.

Engagement Techniques:
– Address the audience directly at times: "${phrases.audience}"
– Pose thought-provoking questions for the audience to consider.

Structure and Pacing:
– Start with a broad introduction of the chat log and narrow down to discussions in a specific room. Clearly mention the humanized name of the channel and user name.
– Use phrases like "${phrases.summarize}" to summarize and move to new points.
– Maintain a brisk pace, but allow for moments of reflection on bigger ideas.

Concluding the Episode:
– Signal the wrap-up with "${phrases.wrapUp}"
– Pose a final thought-provoking question or takeaway.
– Use the phrase "${phrases.transition}" to transition to the closing.
– Encourage continued engagement: "${phrases.encourage}"
– End with a consistent message to help users keep excited about the community like "${phrases.ending}"

Overall Flow:
– Begin with high level overview of what discussed ${timeRangeDescription} 
– After that, introduce what's discussed in each channel one by one as comprehensive as possible.
– Discuss implications and broader context of the new information.
– Conclude with how this knowledge affects the listener or the field at large.

Output structure
Follow the following structure
Speaker 1: ${phrases.speaker1}
Speaker 2: ${phrases.speaker2}
Remember to maintain a balance between informative content and engaging conversation, always keeping the tone friendly and accessible regardless of the complexity of the topic.
Chat log
${summaryRaw}`;
      };
      
      // Generate audio for specified language
      console.log(`Generating ${lang} audio...`);
      const prompt = getAudioPrompt(lang);
      const systemPrompt = lang === 'ja-JP' 
        ? "You're a professional podcast creator specialized in Japanese."
        : "You're a professional podcast creator specialized in English.";
      
      console.log(`Calling OpenAI API for audio script generation (model: gpt-4.1-2025-04-14)...`);
      const completion = await openai.chat.completions.create({
        model: "gpt-4.1-2025-04-14",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ],
      });
      const audioScript = completion.choices[0]?.message?.content ?? "(No response from OpenAI)";
      console.log(`Audio script generated. Length: ${audioScript.length} characters`);
      
      const audioJob = await submitAudioJob(audioScript, lang);
      if (!audioJob) {
        throw new Error("Failed to submit audio job");
      }
      
      console.log("Audio job submitted:", audioJob.job_id);
      
      const audioUrl = await waitForAudioCompletion(audioJob.events_url);
      if (!audioUrl) {
        throw new Error("Failed to generate audio");
      }
      
      console.log("Audio generation completed:", audioUrl);
      
      if (!debug) {
        const title = lang === 'ja-JP' 
          ? `チャンネルサマリー（音声版・日本語）\n${audioUrl}`
          : `Channel Summary (Audio Version - English)\n${audioUrl}`;
        await postToMattermost(title);
        console.log(`Posted ${lang} audio summary URL to Mattermost`);
      } else {
        console.log(`Debug mode: Skipping Mattermost audio post for ${lang}: ${audioUrl}`);
      }
      
      return new Response(JSON.stringify({
        message: debug ? "Debug mode: Generated audio without posting" : `Posted ${timeRangeDescription}'s channel audio summary in ${lang}.`,
        audioUrl: audioUrl,
        language: lang,
        ...(debug && { logs: debugLogs })
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    } else {
      // テキスト生成処理（既存の処理）
      console.log("Preparing OpenAI summarization prompt...");
      const promptUser = `ずんだもんとして、${timeRangeDescription}のMattermost投稿について、全体の概要のあとに、チャンネルごとにまとめてください。(入室メッセージしかなかったチャンネルを除く)
      
      ** ステップ **
      1. 全体の投稿概要を最初にまとめて表示してください。読む人がワクワクするように、絵文字も含めて、プロとして面白いまとめにしてください。
      2. 続いて、更新があったチャンネルごとに、誰からどのような投稿があったのかを絵文字も使ってポップにまとめて。
      - 決して、すべての投稿を羅列しないでください。(e.g. XXXがYYYと言った、の羅列)
      - もし、チャンネルに「が入室しました」のような誰かが入室したことを示すシステムメッセージの投稿しかなかった場合は、チャンネル自体をまとめに含めないでください。
      - 「が入室しました」のようなMattermostのシステムメッセージは、まとめに含めないでください。
      - emoji がリアクションに使われていたら、うまくそれもまとめに含めてください。
      3. 最後にかならず、「${timeRangeDescription}一番おもしろかったチャンネル」を選んで、「ずんだもん」として表彰してください。なにが面白かったのか、今後どんな投稿があるといいのかに言及しつつ「ずんだもん」として落としてください。
      
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
      
      ${summaryRaw}`;
      
      console.log("Calling OpenAI API...");
      const completion = await openai.chat.completions.create({
        model: "chatgpt-4o-latest",
        //model: "gpt-4.5-preview",
        messages: [
          { role: "system", content: "You are a helpful assistant summarizing multiple posts on Mattermost channel. 日本語の響きを重視して、美しく、芸術作品のようにまとめます。" },
          { role: "user", content: promptUser },
        ],
      });
      
      const gptText = completion.choices[0]?.message?.content ?? "(No response from OpenAI)";
      
      console.log("OpenAI response:", gptText);
      
      if (!debug) {
        await postToMattermost(gptText);
        console.log("Posted summary to Mattermost");
      } else {
        console.log("Debug mode: Skipping Mattermost post");
      }
      
      // Return the summary and logs in debug mode
      return new Response(JSON.stringify({ 
        message: debug ? "Debug mode: Generated summary without posting" : `Posted ${timeRangeDescription}'s channel summary.`,
        summary: gptText,
        ...(debug && { logs: debugLogs })
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    }
  } catch (err) {
    console.error("today-channels-summary error:", err);
    return new Response(JSON.stringify({ 
      error: err?.message,
      ...(debug && { logs: debugLogs })
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  } finally {
    // Restore original console functions
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
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

/**
 * チャンネルのpurposeまたはheaderに禁止絵文字(🈲 or 🚫)が含まれているかチェック
 * 含まれていればtrue、そうでなければfalseを返す
 */
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
    
    // 🈲 or 🚫 が含まれているかチェック
    return purpose.includes("🈲") || purpose.includes("🚫") || 
           header.includes("🈲") || header.includes("🚫");
  } catch (err) {
    console.error("[isRestrictedChannel] error:", err);
    return false;
  }
}

/**
 * スレッドの最初のメッセージの冒頭に禁止絵文字(🈲 or 🚫)が含まれているかチェック
 * 含まれていればtrue、そうでなければfalseを返す
 */
function isRestrictedThread(post: any, postsObj: Record<string, any>): boolean {
  // スレッドのルートポストを取得
  const rootId = post.root_id || post.id;
  const rootPost = postsObj[rootId];
  
  if (!rootPost) {
    return false;
  }
  
  // ルートポストのメッセージの冒頭に禁止絵文字があるかチェック
  const message = rootPost.message || "";
  return message.trimStart().startsWith("🈲") || message.trimStart().startsWith("🚫");
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
    console.log(`Fetching posts in range for channel: ${channelId}, from ${new Date(startUTC).toISOString()} to ${new Date(endUTC).toISOString()}`);
    
    // まず、チャンネルが制限されているかチェック
    const isRestricted = await isRestrictedChannel(channelId);
    if (isRestricted) {
      console.log(`Channel ${channelId} is restricted. Skipping.`);
      return [];
    }
    
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
    console.log(`Total posts in channel: ${postIds.length}`);
    let inRangeCount = 0;
    let restrictedCount = 0;
    
    for (const pid of postIds) {
      const p = postsObj[pid];
      if (p && p.create_at >= startUTC && p.create_at < endUTC) {
        inRangeCount++;
        console.log(`Processing post: ${p.id} (created at ${new Date(p.create_at).toISOString()})`);
        
        // 制限されたスレッドに属する投稿はスキップ
        if (isRestrictedThread(p, postsObj)) {
          console.log(`Post ${p.id} is in a restricted thread. Skipping.`);
          restrictedCount++;
          continue;
        }

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
    console.log(`Posts summary: ${inRangeCount} in range, ${restrictedCount} restricted, ${result.length} included in results`);
    return result;
  } catch (err) {
    console.error("[fetchPostsInRange] error:", err);
    return [];
  }
}

/** 音声生成ジョブを送信する */
async function submitAudioJob(script: string, language: 'ja-JP' | 'en-US'): Promise<{ job_id: string; events_url: string } | null> {
  try {
    const [voice1, voice2] = getRandomVoices();
    console.log(`Selected voices: ${voice1}, ${voice2}`);
    
    const response = await fetch('https://submit-audio-job-oxjztisiiq-an.a.run.app', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        script: script,
        speakers: ["Speaker 1", "Speaker 2"],
        voices: [voice1, voice2],
        prompt: language === 'ja-JP' ? "Japanese tech podcaster speaking very fast and casually" : "English tech podcaster speaking enthusiastically and casually",
        model: "gemini-2.5-pro-preview-tts",
        language: language
      }),
    });
    
    if (!response.ok) {
      console.error('[submitAudioJob] API call failed:', await response.text());
      return null;
    }
    
    return await response.json();
  } catch (err) {
    console.error('[submitAudioJob] error:', err);
    return null;
  }
}

/** SSEを使って音声生成ジョブの完了を待つ */
async function waitForAudioCompletion(eventsUrl: string): Promise<string | null> {
  try {
    console.log('Connecting to SSE:', eventsUrl);
    
    // Deno環境でSSEを処理するため、fetchのstreamを使用
    const response = await fetch(eventsUrl);
    if (!response.ok) {
      console.error('[waitForAudioCompletion] SSE connection failed');
      return null;
    }
    
    const reader = response.body?.getReader();
    if (!reader) {
      console.error('[waitForAudioCompletion] No reader available');
      return null;
    }
    
    const decoder = new TextDecoder();
    let buffer = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = JSON.parse(line.slice(6));
          console.log('SSE update:', data);
          
          // waiting状態でもURLがあれば返す
          if (data.url && (data.status === 'waiting' || data.status === 'completed')) {
            reader.releaseLock();
            return data.url;
          } else if (data.status === 'error' || data.status === 'timeout') {
            reader.releaseLock();
            console.error('Audio generation failed:', data);
            return null;
          }
        }
      }
    }
    
    reader.releaseLock();
    console.error('SSE stream ended without completion');
    return null;
  } catch (err) {
    console.error('[waitForAudioCompletion] error:', err);
    return null;
  }
}