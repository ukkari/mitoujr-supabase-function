import { createClient, type Client } from "@libsql/client";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { MattermostClient } from "../src/mattermost";
import { addCalendarDays, jstDate } from "../src/domain/date";
import { registerVideoRoutes, ensureVideoTable } from "../src/routes/video";
import { demoPlan } from "../video/sample";
import { collectVideoSource } from "../video/source";
import { directSummary } from "../video/gemini";

const state = vi.hoisted(() => ({ client: null as unknown as Client }));
vi.mock("@libsql/client/web", () => ({ createClient: () => state.client }));
vi.mock("../video/source", () => ({ collectVideoSource: vi.fn() }));
vi.mock("../video/gemini", async (original) => ({ ...await original<typeof import("../video/gemini")>(),
  directSummary: vi.fn(), shortenNarration: vi.fn(), synthesize: vi.fn() }));
let app: Hono<{ Bindings: Env }>;
const summary = vi.hoisted(() => ({ status: { status: "complete", output: { postId: "summary-post" } } as any }));
const env = { ADMIN_TRIGGER_SECRET: "secret", GEMINI_API_KEY: "gemini", DRY_RUN: "false", MATTERMOST_URL: "https://mattermost.example",
  DAILY_SUMMARY_WORKFLOW: { get: async () => ({ status: async () => summary.status }) } } as unknown as Env;
const date = addCalendarDays(jstDate(), -1);
const request = (path: string, init: RequestInit = {}, bindings = env) => app.request(`/admin/summary-video/${date}/${path}`, {
  ...init, headers: { Authorization: "Bearer secret", ...init.headers },
}, bindings);
const mp4 = new Uint8Array([0, 0, 0, 12, 102, 116, 121, 112, 105, 115, 111, 109]);

beforeEach(async () => {
  state.client = createClient({ url: ":memory:" });
  await ensureVideoTable(state.client);
  app = new Hono<{ Bindings: Env }>();
  registerVideoRoutes(app);
});
afterEach(() => { state.client.close(); vi.restoreAllMocks(); });

async function seed(key = date) {
  await state.client.execute({ sql: "INSERT INTO summary_videos (run_id, plan_json, updated_at, expires_at) VALUES (?, ?, ?, ?)",
    args: [key, JSON.stringify(demoPlan(date)), new Date().toISOString(), new Date(Date.now() + 3600_000).toISOString()] });
}

describe("video admin API", () => {
  it("requires admin auth and validates dates before touching services", async () => {
    expect((await request("prepare", { method: "POST", headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await app.request("/admin/summary-video/2026-02-30/prepare", { method: "POST", headers: { Authorization: "Bearer secret" } }, env)).status).toBe(400);
    vi.mocked(collectVideoSource).mockResolvedValueOnce({ date, label: "昨日", channels: [] });
    expect((await request("prepare", { method: "POST", headers: { Authorization: "Bearer video-only" } }, { ...env, VIDEO_RUNNER_SECRET: "video-only" })).status).toBe(200);
  });
  it("caches the storyboard, skips an empty day, and never writes source posts", async () => {
    vi.mocked(collectVideoSource).mockResolvedValueOnce({ date, label: "昨日", channels: [] });
    expect(await (await request("prepare", { method: "POST" })).json()).toEqual({ status: "no-updates" });
    vi.mocked(collectVideoSource).mockResolvedValueOnce({ date, label: "昨日", channels: [{ name: "n", url: "u", posts: [{ id: "p", userId: "u", user: "n", time: "10:00", message: "private source", reactions: [], replies: 0 }] }] });
    vi.mocked(directSummary).mockResolvedValue(demoPlan(date));
    expect((await request("prepare", { method: "POST" })).status).toBe(200);
    expect((await request("prepare", { method: "POST" })).status).toBe(200);
    expect(directSummary).toHaveBeenCalledOnce();
    expect(JSON.stringify((await state.client.execute("SELECT * FROM summary_videos")).rows)).not.toContain("private source");
  });
  it("posts only once, clears private plan data, and rejects dry runs", async () => {
    await seed();
    const lookup = vi.spyOn(MattermostClient.prototype, "findVideoSummary").mockResolvedValue(null);
    const upload = vi.spyOn(MattermostClient.prototype, "uploadSummaryFile").mockResolvedValue("file");
    const post = vi.spyOn(MattermostClient.prototype, "postVideoSummary").mockResolvedValue({ id: "posted" } as any);
    const init = { method: "PUT", headers: { "Content-Type": "video/mp4" }, body: mp4 };
    expect((await request("publish", init, { ...env, DRY_RUN: "true" })).status).toBe(403);
    expect(await (await request("publish", init)).json()).toEqual({ status: "posted", postId: "posted" });
    expect(await (await request("publish", init)).json()).toEqual({ status: "posted", postId: "posted" });
    expect(upload).toHaveBeenCalledOnce(); expect(post).toHaveBeenCalledOnce(); expect(lookup).toHaveBeenCalledOnce();
    expect(post.mock.calls[0][3]).toBe("summary-post");
    expect((await state.client.execute("SELECT plan_json FROM summary_videos")).rows[0].plan_json).toBeNull();
  });
  it("recovers a lost publish response without another upload or post", async () => {
    await seed();
    await state.client.execute({ sql: "UPDATE summary_videos SET status = 'publishing', updated_at = ?", args: [new Date(Date.now() - 11 * 60_000).toISOString()] });
    vi.spyOn(MattermostClient.prototype, "findVideoSummary").mockResolvedValue({ id: "existing" } as any);
    const upload = vi.spyOn(MattermostClient.prototype, "uploadSummaryFile");
    expect(await (await request("prepare", { method: "POST" })).json()).toEqual({ status: "posted", postId: "existing" });
    expect(upload).not.toHaveBeenCalled();
  });
  it("waits for the daily summary thread before posting", async () => {
    await seed();
    summary.status = { status: "running" };
    const upload = vi.spyOn(MattermostClient.prototype, "uploadSummaryFile");
    expect((await request("publish", { method: "PUT", headers: { "Content-Type": "video/mp4" }, body: mp4 })).status).toBe(425);
    expect(upload).not.toHaveBeenCalled();
    expect((await state.client.execute("SELECT status FROM summary_videos")).rows[0].status).toBe("ready");
    summary.status = { status: "complete", output: { postId: "summary-post" } };
  });
  it("holds a live publish lease to prevent concurrent posts", async () => {
    await seed();
    await state.client.execute("UPDATE summary_videos SET status = 'publishing'");
    expect((await request("publish", { method: "PUT", headers: { "Content-Type": "video/mp4" }, body: mp4 })).status).toBe(409);
  });
  it("serves avatars only for people in the storyboard", async () => {
    await seed();
    const image = vi.spyOn(MattermostClient.prototype, "fetchUserImage").mockResolvedValue({ bytes: new Uint8Array([1, 2]).buffer, type: "image/png" });
    const known = demoPlan(date).posts[0].userId;
    const ok = await request(`avatar/${known}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Content-Type")).toBe("image/png");
    expect((await request(`avatar/${"x".repeat(26)}`)).status).toBe(404);
    expect((await request("avatar/me")).status).toBe(404);
    expect(image).toHaveBeenCalledOnce();
    expect(image).toHaveBeenCalledWith(known);
  });
  it("serves only custom emoji used by the storyboard's posts", async () => {
    const plan = demoPlan(date);
    plan.posts[0].reactions = [{ emoji: ":mitou_fire:", count: 3 }];
    await state.client.execute({ sql: "INSERT INTO summary_videos (run_id, plan_json, updated_at, expires_at) VALUES (?, ?, ?, ?)",
      args: [date, JSON.stringify(plan), new Date().toISOString(), new Date(Date.now() + 3600_000).toISOString()] });
    const image = vi.spyOn(MattermostClient.prototype, "fetchCustomEmojiImage").mockResolvedValue({ bytes: new Uint8Array([1]).buffer, type: "image/gif" });
    expect((await request("emoji/mitou_fire")).status).toBe(200);
    expect((await request("emoji/other")).status).toBe(404);
    expect(image).toHaveBeenCalledOnce();
  });
  it("directs again when the cached storyboard is from an older format", async () => {
    const { posts: _posts, ...rest } = demoPlan(date);
    const old = { ...rest, version: 1 };
    await state.client.execute({ sql: "INSERT INTO summary_videos (run_id, plan_json, updated_at, expires_at) VALUES (?, ?, ?, ?)",
      args: [date, JSON.stringify(old), new Date().toISOString(), new Date(Date.now() + 3600_000).toISOString()] });
    vi.mocked(collectVideoSource).mockResolvedValueOnce({ date, label: "昨日", channels: [{ name: "n", url: "u", posts: [] }] });
    vi.mocked(directSummary).mockResolvedValueOnce(demoPlan(date));
    const body = await (await request("prepare", { method: "POST" })).json() as any;
    expect(body.plan.posts.length).toBeGreaterThan(0);
  });
  it("keeps a test channel delivery separate from the production date", async () => {
    await seed();
    await seed(`test:z-times-yuukai:${date}`);
    vi.spyOn(MattermostClient.prototype, "fetchPublicChannels").mockResolvedValue([
      { id: "test-channel", name: "z-times-yuukai", display_name: "test", type: "O", last_post_at: 1 },
    ]);
    vi.spyOn(MattermostClient.prototype, "findVideoSummary").mockResolvedValue(null);
    vi.spyOn(MattermostClient.prototype, "uploadSummaryFile").mockResolvedValue("file");
    vi.spyOn(MattermostClient.prototype, "postVideoSummary").mockResolvedValue({ id: "test-post" } as any);
    expect((await request("publish", { method: "PUT", headers: { "Content-Type": "video/mp4" }, body: mp4 },
      { ...env, VIDEO_TEST_CHANNEL: "z-times-yuukai" })).status).toBe(200);
    expect(vi.mocked(MattermostClient.prototype.postVideoSummary).mock.calls[0][3]).toBeUndefined();
    const result = await state.client.execute({ sql: "SELECT status FROM summary_videos WHERE run_id = ?", args: [date] });
    expect(result.rows[0].status).toBe("ready");
  });
});
