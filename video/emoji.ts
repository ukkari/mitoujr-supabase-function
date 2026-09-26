// Mattermost reaction names → Unicode for the video. Custom emoji keep their name.
const EMOJI: Record<string, string> = {
  "+1": "👍", thumbsup: "👍", "-1": "👎", thumbsdown: "👎", heart: "❤️", tada: "🎉", joy: "😂",
  laughing: "😆", smile: "😄", grinning: "😀", sweat_smile: "😅", rofl: "🤣", innocent: "😇",
  heart_eyes: "😍", star_struck: "🤩", sob: "😭", cry: "😢", thinking: "🤔", thinking_face: "🤔",
  eyes: "👀", fire: "🔥", rocket: "🚀", sparkles: "✨", star: "⭐", star2: "🌟", zap: "⚡",
  "100": "💯", clap: "👏", raised_hands: "🙌", pray: "🙏", muscle: "💪", ok_hand: "👌",
  white_check_mark: "✅", heavy_check_mark: "✔️", ballot_box_with_check: "☑️", done: "✅",
  bulb: "💡", memo: "📝", books: "📚", link: "🔗", wave: "👋", bow: "🙇", smiley: "😃",
  scream: "😱", exploding_head: "🤯", partying_face: "🥳", confetti_ball: "🎊", trophy: "🏆",
  sunglasses: "😎", ok: "🆗", question: "❓", exclamation: "❗", warning: "⚠️", hugs: "🤗",
  hugging_face: "🤗", relaxed: "☺️", blush: "😊", slightly_smiling_face: "🙂", upside_down_face: "🙃",
  wink: "😉", yum: "😋", sweat: "😓", sleepy: "😪", sleeping: "😴", coffee: "☕", beers: "🍻",
  cake: "🍰", pizza: "🍕", sushi: "🍣", ramen: "🍜", computer: "💻", robot: "🤖", robot_face: "🤖",
  gift: "🎁", seedling: "🌱", sunny: "☀️", rainbow: "🌈", mega: "📣", loudspeaker: "📢",
  point_up: "☝️", point_right: "👉", v: "✌️", handshake: "🤝", saluting_face: "🫡", melting_face: "🫠",
};

// Custom emoji stay as `:name:`; the renderer draws their Mattermost image.
export function emojiFor(name: string): string {
  return EMOJI[name] ?? `:${name}:`;
}

export const customEmojiName = (emoji: string) => /^:([a-z0-9_+\-]{1,64}):$/i.exec(emoji)?.[1] ?? null;

// Inline :shortcodes: in messages become Unicode, or disappear if unknown.
export function replaceShortcodes(text: string): string {
  return text.replace(/:([a-z0-9_+\-]{1,40}):/gi, (_, name: string) => EMOJI[name.toLowerCase()] ?? "");
}
