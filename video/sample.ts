import type { VideoPlan } from "./types";

// Fictional examples only; never sent to Mattermost. The demo uses a test tone,
// not a Gemini voice, and exercises the full renderer/score/MP4 export offline.
export function demoPlan(date: string): VideoPlan {
  const topics = [
    ["動いた！最初の一歩", "試作品の動作確認ができたという、うれしい報告。次の改善点も見えてきました。", "試作品"],
    ["その悩み、一緒に考える", "実装で困ったところに仲間からのヒント。小さな相談が、前進のきっかけです。", "相談"],
    ["使ってもらって、発見", "画面を使ってもらうと、新しい気づきが。感想をもとに操作を見直しています。", "発見"],
    ["調べたことを共有", "調べてわかったことをチャンネルへ。共有した知識が、ほかの挑戦にも役立ちます。", "共有"],
    ["見せ方にもひと工夫", "伝えたいことを整理して、発表の準備。どこが面白いのかを短く伝える練習です。", "発表"],
    ["小さな進捗も大事", "少しずつ進めた作業にも、仲間からの反応。日々の記録が、次の一歩につながります。", "進捗"],
    ["つづきが楽しみ", "試して、相談して、また作る。今日もそれぞれの挑戦が進んだ一日でした。", "挑戦"],
  ];
  return { demo: true, date, label: "昨日", headline: "つくる日々の、進捗速報。", accent: "#93fa59", music: "futurebass", transition: "whip",
    sources: [{ name: "デモ・架空の話題", url: "https://example.invalid", text: "" }],
    scenes: topics.map(([heading, narration, keyword], index) => ({ heading, narration, keyword, source: 0, start: 2 + index * 8, end: 10 + index * 8 })) };
}

export function demoAudio() {
  const sr = 24000, n = sr * 5, buffer = Buffer.alloc(44 + n * 2);
  buffer.write("RIFF"); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sr, 24); buffer.writeUInt32LE(sr * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buffer.writeInt16LE(Math.round(Math.sin(i / sr * Math.PI * 2 * 220) * 3000 * Math.min(1, i / 300, (n - i) / 300)), 44 + i * 2);
  return buffer.toString("base64");
}
