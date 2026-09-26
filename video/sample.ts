import { validatePlan } from "./gemini";
import type { SourcePost, VideoPlan, VideoSource } from "./types";

// Fictional people and posts only; never sent to Mattermost. The demo uses a test tone,
// not a Gemini voice, and exercises the full renderer/score/MP4 export offline.
const people = ["hana", "sora", "riku", "mei", "kaito", "yui", "ren"];
const userId = (name: string) => name.padEnd(26, "0");
const post = (id: number, user: string, time: string, message: string, reactions: Array<[string, number]> = [], replies = 0): SourcePost =>
  ({ id: `demo${id}`, userId: userId(user), user, time, message, replies, reactions: reactions.map(([emoji, count]) => ({ emoji, count })) });

export function demoSource(date: string): VideoSource {
  return { date, label: "昨日", channels: [
    { name: "デモ・進捗報告", url: "https://example.invalid/progress", posts: [
      post(0, "hana", "09:12", "試作品のモーター、ついに動きました！！動画も撮ったので後で貼ります", [["🎉", 9], ["🔥", 6], ["👏", 4]], 5),
      post(1, "riku", "09:20", "おめでとう！最初の一歩だね。電源まわりどうしたの？", [["👍", 3]]),
      post(2, "hana", "09:31", "電池ボックスを2つに分けたら安定しました。次はセンサーをつなぎます", [["💡", 5]]),
      post(3, "kaito", "13:05", "発表スライドの構成を作り直しました。最初に一番面白いところを見せる作戦", [["👀", 4], ["✨", 3]], 2),
      post(4, "ren", "21:40", "今日は細かいバグを3つ直した。地味だけど前進！", [["💪", 7], ["🙌", 2]]),
    ] },
    { name: "デモ・開発相談", url: "https://example.invalid/help", posts: [
      post(5, "sora", "10:02", "画面のボタンを押しても反応しないことがあります。どこから調べればいいですか？", [["🤔", 3]], 4),
      post(6, "mei", "10:15", "まずはボタンの上に透明な要素が重なっていないか確認してみて！", [["💡", 6], ["🙏", 2]]),
      post(7, "sora", "10:40", "重なってました…！直ったので同じところで困った人向けにメモを残します", [["🎉", 5], ["😂", 3]]),
      post(8, "yui", "16:22", "ユーザーテストをしてみたら、説明文を誰も読んでいなかった", [["😂", 8], ["👀", 5]], 3),
      post(9, "kaito", "16:30", "わかる。アイコンで伝える方向に変えたら迷う人が減ったよ", [["👍", 4]]),
    ] },
    { name: "デモ・雑談", url: "https://example.invalid/random", posts: [
      post(10, "mei", "12:10", "調べた論文のまとめをチャンネルに置きました。図が多くて読みやすいです", [["📚", 6], ["🙏", 4]], 1),
      post(11, "riku", "18:03", "みんなのおすすめ作業用BGM教えてください", [["🎧", 3]], 6),
      post(12, "yui", "18:10", "雨の音だけ流すのが最強説", [["🌧", 5], ["😂", 2]]),
      post(13, "ren", "22:15", "明日は朝から実験！早起きがんばる", [["🔥", 3], ["💪", 3]]),
    ] },
  ] };
}

// A Gemini-shaped direction for the demo source (post ids are global indices above).
export function demoDirection() {
  const scenes: Array<[number, string, string, string, string, string[], Array<[number, string]>]> = [
    [0, "progress", "動いた！最初の一歩", "試作品のモーター、ついに動きました！", "試作品", ["🚀", "⚙️", "🎉", "🔋"],
      [[0, "試作品のモーター、ついに動きました！！"], [1, "おめでとう！最初の一歩だね。"], [2, "電池ボックスを2つに分けたら安定しました。"]]],
    [1, "question", "ボタン効かない謎", "ボタンが効かない原因は、透明な要素でした。", "相談", ["🤔", "🔍", "💡", "✅"],
      [[5, "画面のボタンを押しても反応しないことがあります。"], [6, "透明な要素が重なっていないか確認してみて！"], [7, "重なってました…！"]]],
    [1, "fun", "説明文、誰も読まない", "説明文は読まれない。アイコンで伝えたら迷いが減った！", "発見", ["😂", "👀", "📱", "💡"],
      [[8, "説明文を誰も読んでいなかった"], [9, "アイコンで伝える方向に変えたら迷う人が減ったよ"]]],
    [2, "share", "論文まとめ置いといた", "図が多くて読みやすい論文まとめが共有されました。", "共有", ["📚", "🧠", "✨"],
      [[10, "調べた論文のまとめをチャンネルに置きました。"]]],
    [0, "progress", "つかみから見せる！", "発表は一番面白いところから見せる作戦です。", "発表", ["🎤", "🔥", "👀"],
      [[3, "最初に一番面白いところを見せる作戦"]]],
    [2, "fun", "作業用BGM会議", "作業用BGMは雨の音だけが最強説、浮上。", "雑談", ["🎧", "🌧️", "😂", "🎶"],
      [[11, "みんなのおすすめ作業用BGM教えてください"], [12, "雨の音だけ流すのが最強説"]]],
    [0, "progress", "地味だけど前進！", "バグを三つ退治して、明日は朝から実験です。", "前進", ["🐛", "💪", "🔬", "⏰"],
      [[4, "地味だけど前進！"], [13, "明日は朝から実験！早起きがんばる"]]],
  ];
  return { headline: "動いた！直った！盛り上がった！", title: "🚀 モーターが動いた！ボタンの謎も解決 3チャンネル一気見 🔥", emoji: ["🚀", "🔥", "🎉"], accent: "#93fa59", music: "futurebass", transition: "whip",
    scenes: scenes.map(([source, kind, heading, narration, keyword, emoji, posts]) =>
      ({ source, kind, heading, narration, keyword, emoji, posts: posts.map(([id, quote]) => ({ id, quote })) })) };
}

export function demoPlan(date: string): VideoPlan {
  return { ...validatePlan(demoDirection(), demoSource(date)), demo: true };
}

export function demoAudio(seconds = 4) {
  const sr = 24000, n = Math.round(sr * seconds), buffer = Buffer.alloc(44 + n * 2);
  buffer.write("RIFF"); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sr, 24); buffer.writeUInt32LE(sr * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buffer.writeInt16LE(Math.round(Math.sin(i / sr * Math.PI * 2 * 220) * 3000 * Math.min(1, i / 300, (n - i) / 300)), 44 + i * 2);
  return buffer.toString("base64");
}
