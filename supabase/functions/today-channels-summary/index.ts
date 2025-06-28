// supabase/functions/today-channels-summary/index.ts

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import OpenAI from "https://deno.land/x/openai@v4.69.0/mod.ts";
import { getReactions } from "../_shared/mattermost.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/** 環境変数 */
const MATTERMOST_URL = Deno.env.get("MATTERMOST_URL") ?? "";
const MATTERMOST_BOT_TOKEN = Deno.env.get("MATTERMOST_BOT_TOKEN") ?? "";
const MATTERMOST_MAIN_TEAM = Deno.env.get("MATTERMOST_MAIN_TEAM") ?? "";
const MATTERMOST_SUMMARY_CHANNEL = Deno.env.get("MATTERMOST_SUMMARY_CHANNEL") ?? "";

/** OpenAI API キー (GPT-4) */
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";

/** Supabase設定 */
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Supabaseクライアントの初期化
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

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
  let debug = false; // デフォルト値を設定
  
  try {
    const url = new URL(req.url);
    debug = url.searchParams.get('debug') === 'true';
    const forToday = url.searchParams.get('forToday') === 'true';
    const type = url.searchParams.get('type') || 'text'; // デフォルトはtext
    const lang = (url.searchParams.get('lang') || 'ja-JP') as 'ja-JP' | 'en-US'; // デフォルトはja-JP
    const engine = url.searchParams.get('engine') || 'gemini'; // デフォルトはgemini
    
    console.log(`Request parameters: debug=${debug}, forToday=${forToday}, type=${type}, lang=${lang}, engine=${engine}`);
    
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
      
      // Function to generate Zundamon single-person podcast prompt
      const getZundamonAudioPrompt = () => {
        return `ずんだもんとして、${timeRangeDescription}のMattermost投稿についてポッドキャスト形式で一人語りしてください。誰が、どこのチャンネルで何を話していて、何で盛り上がっているのかを聞いた人がざっくり理解できる内容にしてください。

**ずんだもんの設定**
- ずんだ餅の精霊。一人称は「ボク」または「ずんだもん」
- 語尾に「〜のだ」「〜なのだ」を必ず使う
- 明るく元気でフレンドリーな性格
- 時々独り言のような感想を挟む

**ポッドキャストの構成**
1. オープニング
   - 「みんな〜！ずんだもんなのだ！${timeRangeDescription}の未踏ジュニアチャンネルサマリーを始めるのだ！」から始める
   
2. 全体概要
   - ${timeRangeDescription}の投稿の全体的な雰囲気を説明
   - 「${timeRangeDescription}はとってもXXXだったのだ！」のような感想を交える
   
3. チャンネルごとの詳細
   - 各チャンネルについて、誰がどんな投稿をしたか説明
   - Do not use the raw channel names and user names. Make it more 自然な形で日本語で読んで。
   1. "z-times-yuukaiのチャンネルでは" ではなく、「ゆううかいさんのタイムズチャンネルで」、
   2.「yuukaiさんが」ではなく「ゆううかいさんが」など）
   - 「これは面白いのだ！」「ボクもやってみたいのだ！」など、ずんだもんの感想を挟む
   - 時々「えーっと」「なんていうか」「あのー」などの間投詞を使う
   - ずんだもんになりきって、くすっと笑ってしまうちょっとボケを含めるように。
   
4. リアクションの紹介
   - :face_palm: のような記載は、emojiなので、絵文字リアクションがあった場合は「〜の絵文字がついてたのだ！みんなXXしてるのだ！」のように紹介
   
5. 表彰コーナー
   - 「さて、${timeRangeDescription}一番面白かったチャンネルを発表するのだ！」
   - 理由を説明しながら表彰
   - 「これからも楽しい投稿を期待してるのだ！」
   
6. エンディング
   - 「今日のサマリーはここまでなのだ！」
   - 「明日はどんな面白い話があるか楽しみなのだ！」
   - 「みんな、また明日なのだ〜！」

**話し方の特徴**
- 全ての文末に「〜のだ」「〜なのだ」をつける
- 独り言風に「うーん、これは...」「あ、そうそう！」などを挟む
- テンションは常に高め
- 難しい話題も簡単に解説する

**出力形式**
一人語りなので、話者表記は不要。ずんだもんが最初から最後まで一人で話す形式で出力してください。

チャットログ：
${summaryRaw}`;
      };
      
      // Generate audio for specified language
      console.log(`Generating ${lang} audio with engine: ${engine}...`);
      
      // Select prompt based on engine
      const prompt = engine === 'voicevox' ? getZundamonAudioPrompt() : getAudioPrompt(lang);
      const systemPrompt = engine === 'voicevox' 
        ? "あなたはずんだもんとして、楽しいポッドキャストを作るプロフェッショナルです。"
        : (lang === 'ja-JP' 
            ? "You're a professional podcast creator specialized in Japanese."
            : "You're a professional podcast creator specialized in English.");
      
      console.log(`Calling OpenAI API for audio script generation (model: gpt-4.1-2025-04-14, engine: ${engine})...`);
      const completion = await openai.chat.completions.create({
        model: "gpt-4.1-2025-04-14",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ],
      });
      const audioScript = completion.choices[0]?.message?.content ?? "(No response from OpenAI)";
      console.log(`Audio script generated. Length: ${audioScript.length} characters`);
      
      let audioUrl: string | null = null;
      
      if (engine === 'voicevox') {
        // VoiceVoxの場合は直接合成
        audioUrl = await synthesizeWithVoiceVox(audioScript);
        if (!audioUrl) {
          throw new Error("Failed to synthesize audio with VoiceVox");
        }
      } else {
        // Geminiの場合は従来のジョブ方式
        const audioJob = await submitAudioJob(audioScript, lang, engine);
        if (!audioJob) {
          throw new Error("Failed to submit audio job");
        }
        
        console.log("Audio job submitted:", audioJob.job_id);
        
        audioUrl = await waitForAudioCompletion(audioJob.events_url);
        if (!audioUrl) {
          throw new Error("Failed to generate audio");
        }
      }
      
      console.log("Audio generation completed:", audioUrl);
      
      if (!debug) {
        let title;
        if (engine === 'voicevox') {
          title = `:zundamon: ずんだもんのチャンネルサマリー（音声版）なのだ！\n${audioUrl}`;
        } else {
          title = lang === 'ja-JP' 
            ? `チャンネルサマリー（音声版・日本語）\n${audioUrl}`
            : `Channel Summary (Audio Version - English)\n${audioUrl}`;
        }
        await postToMattermost(title);
        console.log(`Posted ${engine} ${lang} audio summary URL to Mattermost`);
      } else {
        console.log(`Debug mode: Skipping Mattermost audio post for ${engine} ${lang}: ${audioUrl}`);
      }
      
      return new Response(JSON.stringify({
        message: debug ? "Debug mode: Generated audio without posting" : `Posted ${timeRangeDescription}'s channel audio summary with ${engine} engine in ${lang}.`,
        audioUrl: audioUrl,
        language: lang,
        engine: engine,
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
async function submitAudioJob(script: string, language: 'ja-JP' | 'en-US', engine: string = 'gemini'): Promise<{ job_id: string; events_url: string } | null> {
  try {
    let requestBody: any;
    let apiUrl: string;
    
    if (engine === 'voicevox') {
      console.log('Using VoiceVox engine for Zundamon');
      // VoiceVox APIのエンドポイントを追加（例: /audio_query や /synthesis など）
      apiUrl = 'https://voicevox-zunda-597706528463.asia-northeast1.run.app/submit-audio-job';
      requestBody = {
        script: script,
        engine: 'voicevox',
        speaker: 3, // ずんだもんのスピーカーID（通常は3）
        speedScale: 1.15, // 話速（1.0が標準、1.15で元気よく速め）
        pitchScale: 0.04, // 音高（0が標準、0.04で少し高めで明るい声）
        intonationScale: 1.5, // 抑揚（1が標準、1.5で表現豊かに）
        volumeScale: 1 // 音量（1が標準）
      };
    } else {
      apiUrl = 'https://submit-audio-job-oxjztisiiq-an.a.run.app';
      const [voice1, voice2] = getRandomVoices();
      console.log(`Selected voices: ${voice1}, ${voice2}`);
      requestBody = {
        script: script,
        speakers: ["Speaker 1", "Speaker 2"],
        voices: [voice1, voice2],
        prompt: language === 'ja-JP' ? "Japanese tech podcaster speaking very fast and casually" : "English tech podcaster speaking enthusiastically and casually",
        model: "gemini-2.5-pro-preview-tts",
        language: language
      };
    }
    
    console.log(`Submitting audio job to ${apiUrl}`);
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
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

/** テキストを適切な長さに分割する */
function splitTextForVoiceVox(text: string, maxLength: number = 500): string[] {
  const sentences = text.split(/(?<=[。！？\n])/);
  const chunks: string[] = [];
  let currentChunk = '';
  
  for (const sentence of sentences) {
    if (currentChunk.length + sentence.length > maxLength && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = sentence;
    } else {
      currentChunk += sentence;
    }
  }
  
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }
  
  return chunks;
}

/** WAVファイルのヘッダーを解析して音声データを取得 */
function extractAudioData(buffer: ArrayBuffer): { data: Uint8Array; sampleRate: number; channels: number; bitsPerSample: number } | null {
  try {
    const view = new DataView(buffer);
    
    // WAVヘッダーの検証
    const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (riff !== 'RIFF') {
      console.error('Not a valid WAV file - missing RIFF header');
      return null;
    }
    
    // フォーマット情報を取得
    const channels = view.getUint16(22, true);
    const sampleRate = view.getUint32(24, true);
    const bitsPerSample = view.getUint16(34, true);
    
    // dataチャンクを探す
    let offset = 12;
    while (offset < buffer.byteLength - 8) {
      const chunkId = String.fromCharCode(
        view.getUint8(offset),
        view.getUint8(offset + 1),
        view.getUint8(offset + 2),
        view.getUint8(offset + 3)
      );
      const chunkSize = view.getUint32(offset + 4, true);
      
      if (chunkId === 'data') {
        const dataStart = offset + 8;
        const data = new Uint8Array(buffer, dataStart, chunkSize);
        return { data, sampleRate, channels, bitsPerSample };
      }
      
      offset += 8 + chunkSize;
      // 奇数サイズのチャンクの場合は1バイトのパディングがある
      if (chunkSize % 2 === 1) {
        offset += 1;
      }
    }
    
    console.error('Data chunk not found in WAV file');
    return null;
  } catch (err) {
    console.error('Error parsing WAV file:', err);
    return null;
  }
}

/** 複数のWAVファイルをマージ */
function mergeWavFiles(buffers: ArrayBuffer[]): ArrayBuffer {
  if (buffers.length === 0) return new ArrayBuffer(0);
  if (buffers.length === 1) return buffers[0];
  
  // 各ファイルから音声データを抽出
  const audioDataList: { data: Uint8Array; sampleRate: number; channels: number; bitsPerSample: number }[] = [];
  
  for (let i = 0; i < buffers.length; i++) {
    const extracted = extractAudioData(buffers[i]);
    if (!extracted) {
      console.error(`Failed to extract audio data from buffer ${i}`);
      continue;
    }
    audioDataList.push(extracted);
  }
  
  if (audioDataList.length === 0) {
    console.error('No valid audio data found');
    return new ArrayBuffer(0);
  }
  
  // 最初のファイルのフォーマットを基準にする
  const { sampleRate, channels, bitsPerSample } = audioDataList[0];
  
  // 全ての音声データを結合
  let totalDataSize = 0;
  for (const audio of audioDataList) {
    totalDataSize += audio.data.length;
  }
  
  // 新しいWAVファイルを作成
  const headerSize = 44;
  const fileSize = headerSize + totalDataSize;
  const outputBuffer = new ArrayBuffer(fileSize);
  const view = new DataView(outputBuffer);
  const outputArray = new Uint8Array(outputBuffer);
  
  // RIFFヘッダー
  outputArray[0] = 0x52; // 'R'
  outputArray[1] = 0x49; // 'I'
  outputArray[2] = 0x46; // 'F'
  outputArray[3] = 0x46; // 'F'
  view.setUint32(4, fileSize - 8, true);
  outputArray[8] = 0x57; // 'W'
  outputArray[9] = 0x41; // 'A'
  outputArray[10] = 0x56; // 'V'
  outputArray[11] = 0x45; // 'E'
  
  // fmtチャンク
  outputArray[12] = 0x66; // 'f'
  outputArray[13] = 0x6D; // 'm'
  outputArray[14] = 0x74; // 't'
  outputArray[15] = 0x20; // ' '
  view.setUint32(16, 16, true); // fmtチャンクサイズ
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bitsPerSample / 8, true);
  view.setUint16(32, channels * bitsPerSample / 8, true);
  view.setUint16(34, bitsPerSample, true);
  
  // dataチャンク
  outputArray[36] = 0x64; // 'd'
  outputArray[37] = 0x61; // 'a'
  outputArray[38] = 0x74; // 't'
  outputArray[39] = 0x61; // 'a'
  view.setUint32(40, totalDataSize, true);
  
  // 音声データをコピー
  let offset = headerSize;
  for (const audio of audioDataList) {
    outputArray.set(audio.data, offset);
    offset += audio.data.length;
  }
  
  console.log(`Merged ${audioDataList.length} WAV files, total size: ${fileSize} bytes`);
  return outputBuffer;
}

/** VoiceVoxを使って音声を直接生成する（長いテキスト対応） */
async function synthesizeWithVoiceVox(script: string): Promise<string | null> {
  try {
    console.log('Synthesizing with VoiceVox...');
    console.log('Total script length:', script.length);
    
    // テキストを分割
    const chunks = splitTextForVoiceVox(script);
    console.log(`Split into ${chunks.length} chunks`);
    
    // 並列処理の開始をわずかにずらす
    const audioPromises = chunks.map(async (chunk, i) => {
      // 各リクエストを少しずつ遅延させて開始
      await new Promise(resolve => setTimeout(resolve, i * 50));
      console.log(`Processing chunk ${i + 1}/${chunks.length}, length: ${chunk.length}`);
      
      try {
        // Step 1: Create audio query
        const audioQueryUrl = `https://voicevox-zunda-597706528463.asia-northeast1.run.app/audio_query?text=${encodeURIComponent(chunk)}&speaker=3`;
        const queryResponse = await fetch(audioQueryUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
        });
        
        if (!queryResponse.ok) {
          console.error(`[synthesizeWithVoiceVox] Audio query failed for chunk ${i + 1}:`, await queryResponse.text());
          return null;
        }
        
        const audioQuery = await queryResponse.json();
        
        // ずんだもんらしい元気な声になるようにパラメータを調整
        audioQuery.speedScale = 1.15;      // 話速を少し速めに
        audioQuery.pitchScale = 0.04;      // 音高を少し高めに（明るい声）
        audioQuery.intonationScale = 1.5;  // 抑揚を豊かに
        audioQuery.volumeScale = 1;        // 音量は標準
        
        // Step 2: Synthesize audio
        const synthesisUrl = `https://voicevox-zunda-597706528463.asia-northeast1.run.app/synthesis?speaker=3`;
        const synthesisResponse = await fetch(synthesisUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(audioQuery),
        });
        
        if (!synthesisResponse.ok) {
          console.error(`[synthesizeWithVoiceVox] Synthesis failed for chunk ${i + 1}:`, await synthesisResponse.text());
          return null;
        }
        
        // Get audio data as ArrayBuffer
        const audioBuffer = await synthesisResponse.arrayBuffer();
        console.log(`Chunk ${i + 1} synthesized, size: ${audioBuffer.byteLength}`);
        
        // マージ前のファイルはアップロードしない - メモリに保持するだけ
        return { index: i, buffer: audioBuffer };
      } catch (err) {
        console.error(`[synthesizeWithVoiceVox] Error processing chunk ${i + 1}:`, err);
        return null;
      }
    });
    
    // 全ての並列処理が完了するのを待つ
    const results = await Promise.all(audioPromises);
    
    // 成功した結果を順番に並べ替え
    const audioBuffers: ArrayBuffer[] = [];
    for (const result of results) {
      if (result && result.buffer) {
        audioBuffers[result.index] = result.buffer;
      }
    }
    
    // null を除去
    const validBuffers = audioBuffers.filter(buffer => buffer != null);
    
    if (validBuffers.length === 0) {
      console.error('[synthesizeWithVoiceVox] No audio chunks were successfully synthesized');
      return null;
    }
    
    console.log(`Successfully synthesized ${validBuffers.length} audio chunks`);
    console.log('Merging audio chunks...');
    // 音声ファイルをマージ
    const mergedBuffer = mergeWavFiles(validBuffers);
    console.log('Merged audio size:', mergedBuffer.byteLength);
    
    // マージした音声もStorageに保存
    const timestamp = new Date().getTime();
    const mergedFileName = `zundamon_merged_${timestamp}.wav`;
    const mergedFilePath = `voice/${mergedFileName}`;
    
    const { data: mergedUploadData, error: mergedUploadError } = await supabase.storage
      .from('audio')
      .upload(mergedFilePath, mergedBuffer, {
        contentType: 'audio/wav',
        upsert: false
      });
      
    if (mergedUploadError) {
      console.error('Failed to upload merged audio to storage:', mergedUploadError);
      // エラーでもbase64として返す
      const base64 = btoa(String.fromCharCode(...new Uint8Array(mergedBuffer)));
      return `data:audio/wav;base64,${base64}`;
    }
    
    // パブリックURLを取得
    const { data: { publicUrl: mergedPublicUrl } } = supabase.storage
      .from('audio')
      .getPublicUrl(mergedFilePath);
      
    console.log(`Merged audio uploaded to: ${mergedPublicUrl}`);
    
    return mergedPublicUrl;
  } catch (err) {
    console.error('[synthesizeWithVoiceVox] error:', err);
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