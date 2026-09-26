import { afterEach, describe, expect, it, vi } from "vitest";
import { directSummary, synthesize, validatePlan } from "../video/gemini";
import { validVideoDate, videoMessage } from "../src/routes/video";
import { demoPlan } from "../video/sample";
import { MattermostClient } from "../src/mattermost";
import type { Env } from "../src/env";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const source = { date: "2026-09-25", label: "昨日" as const,
  channels: [{ name: "開発相談", url: "https://mattermost.example/team/channels/development", text: "private original post" }] };

describe("Japanese video direction", () => {
  it("uses exactly 60 seconds with beat-aligned scenes and removes raw source bodies", () => {
    const raw = demoPlan(source.date);
    const plan = validatePlan(raw, source);
    expect(plan.scenes[0].start).toBe(2);
    expect(plan.scenes.at(-1)?.end).toBe(58);
    expect(plan.scenes.every((scene, i) => scene.start % 2 === 0 && (i === 0 || scene.start === plan.scenes[i - 1].end))).toBe(true);
    expect(JSON.stringify(plan)).not.toContain("private original post");
  });
  it("rejects invented source indices and overlong narration", () => {
    const raw = demoPlan(source.date);
    raw.scenes[0].source = 100;
    expect(() => validatePlan(raw, source)).toThrow("Invalid video scene");
    raw.scenes[0].source = 0;
    raw.scenes[0].narration = "あ".repeat(45);
    expect(() => validatePlan(raw, source)).toThrow("reading budget");
  });
  it("uses Gemini for directing and current TTS metadata without exposing errors", async () => {
    const mock = vi.fn()
      .mockResolvedValueOnce(Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(demoPlan(source.date)) }] } }] }))
      .mockResolvedValueOnce(Response.json({ steps: [{ type: "model_output", content: [{ type: "audio", data: "wav-base64" }] }] }))
      .mockResolvedValueOnce(new Response("private-error-with-secret", { status: 429 }));
    vi.stubGlobal("fetch", mock);
    const config = { GEMINI_API_KEY: "test-secret" };
    await directSummary(config, source);
    expect(await synthesize(config, "日本語の本文。" )).toBe("wav-base64");
    const request = JSON.parse(mock.mock.calls[1][1].body);
    expect(request.model).toBe("gemini-3.8-flash-tts");
    expect(request.input[0].content[0].text).toBe("日本語の本文。");
    expect(request.input[0].content[0].annotations[0].type).toBe("speech_metadata");
    expect(request.store).toBe(false);
    await expect(synthesize(config, "本文")).rejects.toThrow("Gemini request failed (429)");
    expect(mock).toHaveBeenCalledTimes(3);
  });
  it("uses validated source links and removes mentions from the post", () => {
    const plan = validatePlan(demoPlan(source.date), source);
    plan.headline = "@all [外部](evil)";
    expect(videoMessage(plan)).not.toContain("@all");
    expect(videoMessage(plan)).toContain(`[開発相談](${source.channels[0].url})`);
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
});
