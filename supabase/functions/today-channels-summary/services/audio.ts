import OpenAI from "https://deno.land/x/openai@v4.69.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { mergeWavFiles } from "../utils/wav-helper.ts";

type Language = "ja-JP" | "en-US";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  "";

const AUDIO_JOB_API_URL = Deno.env.get("AUDIO_JOB_API_URL") || "";
const VOICEVOX_API_URL = Deno.env.get("VOICEVOX_API_URL") || "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

const AVAILABLE_VOICES = [
  "Zephyr",
  "Puck",
  "Charon",
  "Kore",
  "Fenrir",
  "Leda",
  "Orus",
  "Aoede",
  "Callirhoe",
  "Autonoe",
  "Enceladus",
  "Iapetus",
  "Umbriel",
  "Algieba",
  "Despina",
  "Erinome",
  "Algenib",
  "Rasalgethi",
  "Laomedeia",
  "Achernar",
  "Alnilam",
  "Schedar",
  "Gacrux",
  "Pulcherrima",
  "Achird",
  "Zubenelgenubi",
  "Vindemiatrix",
  "Sadachbia",
  "Sadaltager",
  "Sulafar",
];

export type AudioOptions = {
  summaryRaw: string;
  timeRangeDescription: string;
  lang: Language;
  engine: string;
};

export async function generateAudioSummary(
  options: AudioOptions,
): Promise<{ audioUrl: string; script: string }> {
  const { summaryRaw, timeRangeDescription, lang, engine } = options;

  const prompt = engine === "voicevox"
    ? getZundamonAudioPrompt(timeRangeDescription, summaryRaw)
    : getAudioPrompt(timeRangeDescription, summaryRaw, lang);

  const systemPrompt = engine === "voicevox"
    ? "あなたはずんだもんとして、楽しいポッドキャストを作るプロフェッショナルです。"
    : (lang === "ja-JP"
      ? "You're a professional podcast creator specialized in Japanese."
      : "You're a professional podcast creator specialized in English.");

  console.log(
    `Calling OpenAI API for audio script generation (model: gpt-4.1-2025-04-14, engine: ${engine})...`,
  );

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-2025-04-14",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ],
  });

  const audioScript = completion.choices[0]?.message?.content ??
    "(No response from OpenAI)";
  console.log(
    `Audio script generated. Length: ${audioScript.length} characters`,
  );

  let audioUrl: string | null = null;

  if (engine === "voicevox") {
    audioUrl = await synthesizeWithVoiceVox(audioScript);
    if (!audioUrl) {
      throw new Error("Failed to synthesize audio with VoiceVox");
    }
  } else {
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
  return { audioUrl, script: audioScript };
}

function getRandomVoices(): [string, string] {
  const shuffled = [...AVAILABLE_VOICES].sort(() => Math.random() - 0.5);
  return [shuffled[0], shuffled[1]];
}

function getAudioPrompt(
  timeRangeDescription: string,
  summaryRaw: string,
  language: Language,
) {
  const isJapanese = language === "ja-JP";
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
    analogy: isJapanese ? "まるで XXX みたい！" : "It's like XXX!",
    validation: isJapanese ? "いやー、わかってますね" : "wow, you really get it",
    audience: isJapanese
      ? "今聞いている未踏ジュニアのみなさんも"
      : "For those of you listening from Mitou Junior",
    summarize: isJapanese ? "まとめると" : "to sum it up",
    wrapUp: isJapanese ? "そろそろ時間なんですが" : "We're running out of time, but",
    transition: isJapanese ? "じゃあ" : "so",
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
    community: isJapanese ? "未踏ジュニアコミュニティ" : "Mitou Junior Community",
    projectName: isJapanese ? "未踏ジュニア" : "Mitou Junior",
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
}

function getZundamonAudioPrompt(
  timeRangeDescription: string,
  summaryRaw: string,
) {
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
}

async function submitAudioJob(
  script: string,
  language: Language,
  engine: string,
): Promise<{ job_id: string; events_url: string } | null> {
  try {
    let requestBody: any;
    let apiUrl: string;

    if (engine === "voicevox") {
      apiUrl = `${VOICEVOX_API_URL}/submit-audio-job`;
      requestBody = {
        script,
        engine: "voicevox",
        speaker: 3,
        speedScale: 1.15,
        pitchScale: 0.04,
        intonationScale: 1.5,
        volumeScale: 1,
      };
    } else {
      apiUrl = AUDIO_JOB_API_URL;
      const [voice1, voice2] = getRandomVoices();
      console.log(`Selected voices: ${voice1}, ${voice2}`);
      requestBody = {
        script,
        speakers: ["Speaker 1", "Speaker 2"],
        voices: [voice1, voice2],
        prompt: language === "ja-JP"
          ? "Japanese tech podcaster speaking very fast and casually"
          : "English tech podcaster speaking enthusiastically and casually",
        model: "gemini-2.5-pro-preview-tts",
        language,
      };
    }

    console.log(`Submitting audio job to ${apiUrl}`);
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      console.error("[submitAudioJob] API call failed:", await response.text());
      return null;
    }

    return await response.json();
  } catch (err) {
    console.error("[submitAudioJob] error:", err);
    return null;
  }
}

function splitTextForVoiceVox(text: string, maxLength = 500): string[] {
  const sentences = text.split(/(?<=[。！？\n])/);
  const chunks: string[] = [];
  let currentChunk = "";

  for (const sentence of sentences) {
    if (currentChunk.length + sentence.length > maxLength &&
      currentChunk.length > 0) {
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

async function synthesizeWithVoiceVox(
  script: string,
): Promise<string | null> {
  try {
    console.log("Synthesizing with VoiceVox...");
    console.log("Total script length:", script.length);

    const chunks = splitTextForVoiceVox(script);
    console.log(`Split into ${chunks.length} chunks`);

    const audioPromises = chunks.map(async (chunk, i) => {
      await new Promise((resolve) => setTimeout(resolve, i * 50));
      console.log(
        `Processing chunk ${i + 1}/${chunks.length}, length: ${chunk.length}`,
      );

      try {
        const audioQueryUrl =
          `${VOICEVOX_API_URL}/audio_query?text=${encodeURIComponent(chunk)}&speaker=3`;
        const queryResponse = await fetch(audioQueryUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
        });

        if (!queryResponse.ok) {
          console.error(
            `[synthesizeWithVoiceVox] Audio query failed for chunk ${i + 1}:`,
            await queryResponse.text(),
          );
          return null;
        }

        const audioQuery = await queryResponse.json();

        audioQuery.speedScale = 1.15;
        audioQuery.pitchScale = 0.04;
        audioQuery.intonationScale = 1.5;
        audioQuery.volumeScale = 1;

        const synthesisUrl = `${VOICEVOX_API_URL}/synthesis?speaker=3`;
        const synthesisResponse = await fetch(synthesisUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(audioQuery),
        });

        if (!synthesisResponse.ok) {
          console.error(
            `[synthesizeWithVoiceVox] Synthesis failed for chunk ${i + 1}:`,
            await synthesisResponse.text(),
          );
          return null;
        }

        const audioBuffer = await synthesisResponse.arrayBuffer();
        console.log(
          `Chunk ${i + 1} synthesized, size: ${audioBuffer.byteLength}`,
        );
        return { index: i, buffer: audioBuffer };
      } catch (err) {
        console.error(`[synthesizeWithVoiceVox] Error chunk ${i + 1}:`, err);
        return null;
      }
    });

    const results = await Promise.all(audioPromises);

    const audioBuffers: ArrayBuffer[] = [];
    for (const result of results) {
      if (result && result.buffer) {
        audioBuffers[result.index] = result.buffer;
      }
    }

    const validBuffers = audioBuffers.filter((buffer) => buffer != null);
    if (validBuffers.length === 0) {
      console.error(
        "[synthesizeWithVoiceVox] No audio chunks were successfully synthesized",
      );
      return null;
    }

    console.log(`Successfully synthesized ${validBuffers.length} audio chunks`);
    console.log("Merging audio chunks...");

    const mergedBuffer = mergeWavFiles(validBuffers);
    console.log("Merged audio size:", mergedBuffer.byteLength);

    const timestamp = new Date().getTime();
    const mergedFileName = `zundamon_merged_${timestamp}.wav`;
    const mergedFilePath = `voice/${mergedFileName}`;

    const { error: mergedUploadError } = await supabase.storage
      .from("audio")
      .upload(mergedFilePath, mergedBuffer, {
        contentType: "audio/wav",
        upsert: false,
      });

    if (mergedUploadError) {
      console.error("Failed to upload merged audio to storage:", mergedUploadError);
      const base64 = btoa(String.fromCharCode(...new Uint8Array(mergedBuffer)));
      return `data:audio/wav;base64,${base64}`;
    }

    const { data: { publicUrl: mergedPublicUrl } } = supabase.storage
      .from("audio")
      .getPublicUrl(mergedFilePath);

    console.log(`Merged audio uploaded to: ${mergedPublicUrl}`);
    return mergedPublicUrl;
  } catch (err) {
    console.error("[synthesizeWithVoiceVox] error:", err);
    return null;
  }
}

async function waitForAudioCompletion(eventsUrl: string): Promise<string | null> {
  try {
    console.log("Connecting to SSE:", eventsUrl);

    const response = await fetch(eventsUrl);
    if (!response.ok) {
      console.error("[waitForAudioCompletion] SSE connection failed");
      return null;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      console.error("[waitForAudioCompletion] No reader available");
      return null;
    }

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = JSON.parse(line.slice(6));
          console.log("SSE update:", data);

          if (data.url && (data.status === "waiting" || data.status === "completed")) {
            reader.releaseLock();
            return data.url;
          } else if (data.status === "error" || data.status === "timeout") {
            reader.releaseLock();
            console.error("Audio generation failed:", data);
            return null;
          }
        }
      }
    }

    reader.releaseLock();
    console.error("SSE stream ended without completion");
    return null;
  } catch (err) {
    console.error("[waitForAudioCompletion] error:", err);
    return null;
  }
}
