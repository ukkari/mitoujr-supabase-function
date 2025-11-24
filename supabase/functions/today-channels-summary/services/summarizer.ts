import OpenAI from "https://deno.land/x/openai@v4.69.0/mod.ts";

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

export async function generateTextSummary(
  summaryRaw: string,
  timeRangeDescription: string,
): Promise<string> {
  const countdown = calculateCountdown();

  const promptUser = `ずんだもんとして、${timeRangeDescription}のMattermost投稿について、全体の概要のあとに、チャンネルごとにまとめてください。(入室メッセージしかなかったチャンネルを除く)

** ステップ **
1. 全体の投稿概要を最初にまとめて表示してください。読む人がワクワクするように、絵文字も含めて、プロとして面白いまとめにしてください。

2025年11月3日に未踏ジュニア成果報告会が開催されるまでの残り時間を、クリエイティブな形式で伝えてください。
- 残り日数: ${countdown.days}日
- 残り時間: ${countdown.hours}時間
- 残り分数: ${countdown.minutes}分
- 残り秒数: ${countdown.seconds}秒
- それぞれの単位に面白い比喩を加える（例：「カップラーメンをX個作る時間」「東京〜大阪をX往復する時間」「アニメをX話見られる時間」など）
- ずんだもんらしく元気で面白い表現にする

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

  const completion = await openai.chat.completions.create({
    model: "chatgpt-4o-latest",
    messages: [
      {
        role: "system",
        content:
          "You are a helpful assistant summarizing multiple posts on Mattermost channel. 日本語の響きを重視して、美しく、芸術作品のようにまとめます。",
      },
      { role: "user", content: promptUser },
    ],
  });

  return completion.choices[0]?.message?.content ?? "(No response from OpenAI)";
}

function calculateCountdown() {
  const eventDate = new Date("2025-11-03T00:00:00+09:00");
  const now = new Date();
  const diffMs = eventDate.getTime() - now.getTime();

  return {
    days: Math.floor(diffMs / (1000 * 60 * 60 * 24)),
    hours: Math.floor(diffMs / (1000 * 60 * 60)),
    minutes: Math.floor(diffMs / (1000 * 60)),
    seconds: Math.floor(diffMs / 1000),
  };
}
