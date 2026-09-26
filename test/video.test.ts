import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanText, directSummary, emojiOf, pickQuote, synthesize, validatePlan } from "../video/gemini";
import { validVideoDate, videoMessage } from "../src/routes/video";
import { demoDirection, demoSource } from "../video/sample";
import { MattermostClient } from "../src/mattermost";
import type { Env } from "../src/env";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const source = demoSource("2026-09-25");

describe("Japanese video direction", () => {
  it("uses short beat-aligned scenes, emoji, and keeps only short post excerpts", () => {
    const plan = validatePlan(demoDirection(), source);
    expect(plan.scenes[0].start).toBe(2);
    expect(plan.scenes.every((scene, i) => scene.end - scene.start === 4 && (i === 0 || scene.start === plan.scenes[i - 1].end))).toBe(true);
    expect(plan.emoji).toEqual(["🚀", "🔥", "🎉"]);
    expect(plan.scenes[0].emoji).toEqual(["🚀", "⚙️", "🎉", "🔋"]);
    expect(plan.scenes[0].posts).toEqual([0, 1, 2]);
    expect(plan.posts[0]).toMatchObject({ user: "hana", time: "09:12", text: "試作品のモーター、ついに動きました！！", replies: 5 });
    expect(plan.posts[0].reactions[0]).toEqual({ emoji: "🎉", count: 9 });
    expect(plan.stats).toEqual({ posts: 14, channels: 3, people: 7, reactions: 105 });
    expect(plan.stars[0]).toMatchObject({ user: "hana", posts: 2 });
    expect(plan.sources[1]).toMatchObject({ name: "デモ・開発相談", posts: 5, people: 4, top: "sora".padEnd(26, "0") });
    expect(JSON.stringify(plan)).not.toContain("後で貼ります");
  });
  it("rejects invented source indices and overlong narration", () => {
    const raw = demoDirection();
    raw.scenes[0].source = 100;
    expect(() => validatePlan(raw, source)).toThrow("Invalid video scene");
    raw.scenes[0].source = 0;
    raw.scenes[0].narration = "あ".repeat(35);
    expect(() => validatePlan(raw, source)).toThrow("reading budget");
    raw.scenes[0].narration = "短い文です。";
    raw.scenes = Array.from({ length: 14 }, () => raw.scenes[0]);
    expect(() => validatePlan(raw, source)).toThrow("Invalid video direction");
  });
  it("keeps only real emoji from the model", () => {
    expect(emojiOf(["🔥", "abc", "👍🏽", "👨‍💻", "🎉🎉", 5, "✨", "🚀", "💯"])).toEqual(["🔥", "👍🏽", "👨‍💻", "✨", "🚀"]);
  });
  it("shows only verbatim quotes and falls back to real posts", () => {
    const raw = demoDirection();
    raw.scenes[0].posts = [{ id: 0, quote: "世界初の快挙を達成" }, { id: 999, quote: "x" }];
    raw.scenes[1].posts = [];
    const plan = validatePlan(raw, source);
    expect(plan.posts[plan.scenes[0].posts[0]].text).toBe("試作品のモーター、ついに動きました！！動画も撮ったので後で貼ります");
    expect(pickQuote("あ".repeat(50), "い")).toBe("あ".repeat(41) + "…");
    expect(plan.scenes[0].posts).toHaveLength(1);
    expect(plan.posts[plan.scenes[1].posts[0]].user).toBe("sora");
  });
  it("turns Markdown posts into one plain line", () => {
    expect(cleanText("## 見出し\n**太字** [資料](https://x.example) :tada:\n```js\nsecret()\n``` https://a.example/b <b>")).toBe("見出し 太字 資料 🎉 ［コード］ 🔗 b");
  });
  it("uses Gemini for directing and current TTS metadata without exposing errors", async () => {
    const mock = vi.fn()
      .mockResolvedValueOnce(Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(demoDirection()) }] } }] }))
      .mockResolvedValueOnce(Response.json({ steps: [{ type: "model_output", content: [{ type: "audio", data: "wav-base64" }] }] }))
      .mockResolvedValueOnce(new Response("private-error-with-secret", { status: 429 }));
    vi.stubGlobal("fetch", mock);
    const config = { GEMINI_API_KEY: "test-secret" };
    await directSummary(config, source);
    const input = JSON.parse(JSON.parse(mock.mock.calls[0][1].body).contents[0].parts[0].text);
    expect(input.channels[1].posts[0]).toMatchObject({ id: 5, user: "sora", reactions: "🤔×3", replies: 4 });
    expect(await synthesize(config, "日本語の本文。" )).toBe("wav-base64");
    const request = JSON.parse(mock.mock.calls[1][1].body);
    expect(request.model).toBe("gemini-3.8-flash-tts");
    expect(request.input[0].content[0].text).toBe("日本語の本文。");
    expect(request.input[0].content[0].annotations[0].type).toBe("speech_metadata");
    expect(request.store).toBe(false);
    await expect(synthesize(config, "本文")).rejects.toThrow("Gemini request failed (429)");
    expect(mock).toHaveBeenCalledTimes(3);
  });
  it("posts only the emoji title, without links or mentions", () => {
    const plan = validatePlan(demoDirection(), source);
    expect(videoMessage(plan)).toBe("🚀 モーターが動いた！ボタンの謎も解決 3チャンネル一気見 🔥");
    plan.title = "@all [外部](https://evil.example) ## 見て";
    expect(videoMessage(plan)).toBe("🎬 all 外部 見て");
  });
  it("accepts only real dates within the last seven JST days", () => {
    const now = new Date("2026-09-25T22:00:00Z");
    expect(validVideoDate("2026-09-25", now)).toBe(true);
    for (const date of ["2026-09-31", "2026-09-27", "2026-09-18", "invalid"]) expect(validVideoDate(date, now)).toBe(false);
  });
});

describe("Mattermost video collection and upload", () => {
  const env = { MATTERMOST_URL: "https://mattermost.example", MATTERMOST_BOT_TOKEN: "test", MATTERMOST_SUMMARY_CHANNEL: "summary" } as Env;
  it("uploads an MP4 with its actual MIME type and filename", async () => {
    const mock = vi.fn().mockResolvedValue(Response.json({ file_infos: [{ id: "video-id" }] }));
    vi.stubGlobal("fetch", mock);
    await expect(new MattermostClient(env).uploadSummaryFile(new Uint8Array([0, 1]), { name: "summary.mp4", type: "video/mp4" })).resolves.toBe("video-id");
    const file = (mock.mock.calls[0][1].body as FormData).get("files") as File;
    expect(file.type).toBe("video/mp4");
    expect(file.name).toBe("summary.mp4");
  });
  it("paginates a busy day and excludes replies to older restricted roots", async () => {
    const batch = Array.from({ length: 200 }, (_, i) => ({ id: `p${i}`, channel_id: "c", user_id: "u", create_at: 500 - i, message: "hello" }));
    const older = { id: "old", channel_id: "c", root_id: "root", user_id: "u", create_at: 200, message: "private reply" };
    const mock = vi.fn(async (url: string) => {
      if (url.endsWith("/channels/c")) return Response.json({ header: "" });
      if (url.includes("page=0")) return Response.json({ order: batch.map(p => p.id), posts: Object.fromEntries(batch.map(p => [p.id, p])) });
      if (url.includes("page=1")) return Response.json({ order: ["old"], posts: { old: older } });
      if (url.endsWith("/posts/root")) return Response.json({ id: "root", channel_id: "c", message: "🚫 private" });
      if (url.endsWith("/reactions")) return Response.json([]);
      throw new Error("Unexpected request");
    });
    vi.stubGlobal("fetch", mock);
    const result = await new MattermostClient(env).fetchPostsInRange("c", 100, 1000);
    expect(result).toHaveLength(200);
    expect(result.some(p => p.id === "old")).toBe(false);
    expect(mock.mock.calls.some(([url]) => url.includes("page=1"))).toBe(true);
  });
  it("can keep reactions structured instead of appending them to the message", async () => {
    const mock = vi.fn(async (url: string) => {
      if (url.endsWith("/channels/c")) return Response.json({ header: "" });
      if (url.includes("page=0")) return Response.json({ order: ["p"], posts: { p: { id: "p", channel_id: "c", user_id: "u", create_at: 500, message: "hi" } } });
      if (url.endsWith("/reactions")) return Response.json([{ user_id: "a", emoji_name: "tada" }]);
      throw new Error("Unexpected request");
    });
    vi.stubGlobal("fetch", mock);
    const [post] = await new MattermostClient(env).fetchPostsInRange("c", 100, 1000, { appendReactions: false });
    expect(post.message).toBe("hi");
    expect(post.reactions).toEqual([{ user_id: "a", emoji_name: "tada" }]);
  });
});
