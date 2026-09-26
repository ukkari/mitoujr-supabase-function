import { createClient, type Client } from "@libsql/client/web";
import { Hono } from "hono";
import type { Env } from "../env";
import { secureEqual } from "./slash";
import { addCalendarDays, jstDate } from "../domain/date";
import { MattermostClient } from "../mattermost";
import { workflowId } from "./admin";
import { collectVideoSource } from "../../video/source";
import { directSummary, shortenNarration, synthesize } from "../../video/gemini";
import { customEmojiName } from "../../video/emoji";
import { PLAN_VERSION, type GeminiConfig, type VideoPlan } from "../../video/types";

function db(env: Env) {
  return createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
}

function runKey(env: Env, date: string) {
  return env.VIDEO_TEST_CHANNEL ? `test:${env.VIDEO_TEST_CHANNEL}:${date}` : date;
}

async function videoClient(env: Env): Promise<MattermostClient> {
  if (!env.VIDEO_TEST_CHANNEL) return new MattermostClient(env);
  const channels = await new MattermostClient(env).fetchPublicChannels(env.MATTERMOST_MAIN_TEAM);
  const channel = channels.find((channel) => channel.name === env.VIDEO_TEST_CHANNEL && channel.type === "O");
  if (!channel) throw new Error("Configured video test channel was not found");
  return new MattermostClient({ ...env, MATTERMOST_SUMMARY_CHANNEL: channel.id });
}

export async function ensureVideoTable(client: Client) {
  // Lazy, idempotent bootstrap also lets an existing Worker deploy use the new
  // endpoint without moving Turso credentials into the rendering job.
  await client.execute(`CREATE TABLE IF NOT EXISTS summary_videos (
    run_id TEXT PRIMARY KEY, plan_json TEXT,
    status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'publishing', 'posted')),
    claim_token TEXT, file_id TEXT, post_id TEXT, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL
  )`);
}

export async function cleanupVideoPlans(env: Env, now = new Date()) {
  const client = db(env);
  const exists = await client.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'summary_videos'");
  if (exists.rows.length) await client.execute({
    sql: "UPDATE summary_videos SET plan_json = NULL WHERE expires_at <= ?", args: [now.toISOString()],
  });
}

function config(env: Env): GeminiConfig {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured on the Worker");
  return { ...env, GEMINI_API_KEY: env.GEMINI_API_KEY };
}

async function loadPlan(client: Client, date: string): Promise<VideoPlan | null> {
  const result = await client.execute({ sql: "SELECT plan_json FROM summary_videos WHERE run_id = ? AND expires_at > ?",
    args: [date, new Date().toISOString()] });
  return typeof result.rows[0]?.plan_json === "string" ? JSON.parse(result.rows[0].plan_json) : null;
}

export function validVideoDate(value: string, now = new Date()): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  try {
    return addCalendarDays(value, 0) === value && value <= jstDate(now) &&
      value >= addCalendarDays(jstDate(now), -7);
  } catch { return false; }
}

export function videoMessage(plan: VideoPlan): string {
  // Title only. Keep model text out of Markdown, mentions, links and headings.
  const plain = (text: string) => text.replace(/[@#\[\]()*_`~<>|\\]|https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
  const title = plain(plan.title ?? "") || plain(plan.headline);
  return /\p{Extended_Pictographic}/u.test(title) ? title : `🎬 ${title}`;
}

// The daily text + image summary is posted by the `summary-<date>` workflow; the video joins its thread.
async function summaryPostId(env: Env, date: string): Promise<string | null> {
  try {
    const status = await (await env.DAILY_SUMMARY_WORKFLOW.get(workflowId(date))).status();
    const output = typeof status.output === "string" ? JSON.parse(status.output) : status.output;
    const postId = (output as { postId?: unknown } | undefined)?.postId;
    return status.status === "complete" && typeof postId === "string" ? postId : null;
  } catch {
    return null;
  }
}

export function registerVideoRoutes(app: Hono<{ Bindings: Env }>) {
  app.use("/admin/summary-video/:date/*", async (c, next) => {
    const token = c.req.header("Authorization") ?? "";
    const valid = token.startsWith("Bearer ") && (
      (c.env.VIDEO_RUNNER_SECRET && await secureEqual(token.slice(7), c.env.VIDEO_RUNNER_SECRET)) ||
      await secureEqual(token.slice(7), c.env.ADMIN_TRIGGER_SECRET)
    );
    if (!valid) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    c.header("Cache-Control", "no-store");
    if (!validVideoDate(c.req.param("date") ?? "")) return c.json({ error: "Invalid video date (last 7 JST days only)" }, 400);
    await next();
  });

  app.post("/admin/summary-video/:date/prepare", async (c) => {
    const date = c.req.param("date"), key = runKey(c.env, date), client = db(c.env);
    await ensureVideoTable(client);
    // Retain delivery metadata, erase expired private storyboards.
    await client.execute({ sql: "UPDATE summary_videos SET plan_json = NULL WHERE expires_at <= ?", args: [new Date().toISOString()] });
    const row = (await client.execute({ sql: "SELECT status, post_id, updated_at FROM summary_videos WHERE run_id = ?", args: [key] })).rows[0];
    if (row?.status === "posted") return c.json({ status: "posted", postId: row.post_id });
    if (row?.status === "publishing") {
      if (String(row.updated_at) >= new Date(Date.now() - 10 * 60 * 1000).toISOString()) {
        return c.json({ error: "Video delivery is already in progress" }, 409);
      }
      const existing = await (await videoClient(c.env)).findVideoSummary(date);
      if (existing) {
        await client.execute({ sql: "UPDATE summary_videos SET status = 'posted', post_id = ?, plan_json = NULL WHERE run_id = ?", args: [existing.id, key] });
        return c.json({ status: "posted", postId: existing.id });
      }
      await client.execute({ sql: "UPDATE summary_videos SET status = 'ready' WHERE run_id = ? AND status = 'publishing' AND updated_at = ?", args: [key, row.updated_at] });
    }
    const cached = await loadPlan(client, key);
    if (cached?.version === PLAN_VERSION) return c.json({ status: "ready", plan: cached });
    // A storyboard from a previous format lacks fields the renderer needs; direct it again.
    if (cached) await client.execute({ sql: "UPDATE summary_videos SET plan_json = NULL WHERE run_id = ? AND status = 'ready'", args: [key] });
    const gemini = config(c.env);
    const source = await collectVideoSource(c.env, date);
    if (!source.channels.length) return c.json({ status: "no-updates" });
    const plan = await directSummary(gemini, source);
    const now = new Date(), expires = new Date(now.getTime() + 48 * 60 * 60 * 1000);
    await client.execute({
      sql: `INSERT INTO summary_videos (run_id, plan_json, updated_at, expires_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET plan_json = excluded.plan_json,
          expires_at = excluded.expires_at, file_id = NULL
          WHERE summary_videos.plan_json IS NULL AND summary_videos.status = 'ready'`,
      args: [key, JSON.stringify(plan), now.toISOString(), expires.toISOString()],
    });
    const saved = await loadPlan(client, key);
    if (!saved) return c.json({ error: "Video delivery is already in progress" }, 409);
    return c.json({ status: "ready", plan: saved });
  });

  app.post("/admin/summary-video/:date/audio/:index", async (c) => {
    const client = db(c.env), date = c.req.param("date"), key = runKey(c.env, date);
    const plan = await loadPlan(client, key);
    const index = Number(c.req.param("index"));
    if (!plan || !Number.isInteger(index) || !plan.scenes[index]) return c.json({ error: "Scene not found" }, 404);
    const body = await c.req.json<{ maxChars?: number }>().catch(() => ({} as { maxChars?: number }));
    const scene = plan.scenes[index], gemini = config(c.env);
    if (body.maxChars !== undefined) {
      if (!Number.isInteger(body.maxChars) || body.maxChars < 8 || body.maxChars >= [...scene.narration].length) {
        return c.json({ error: "Invalid shorter narration budget" }, 400);
      }
      // Patch only this scene atomically; concurrent audio calls cannot lose edits.
      const shorter = await shortenNarration(gemini, scene.narration, body.maxChars);
      const updated = await client.execute({ sql: "UPDATE summary_videos SET plan_json = json_set(plan_json, ?, ?) WHERE run_id = ? AND status = 'ready' AND expires_at > ?",
        args: [`$.scenes[${index}].narration`, shorter, key, new Date().toISOString()] });
      if (!updated.rowsAffected) return c.json({ error: "Storyboard expired or already publishing" }, 409);
      scene.narration = shorter;
    }
    return c.json({ audio: await synthesize(gemini, scene.narration), narration: scene.narration });
  });

  app.get("/admin/summary-video/:date/avatar/:userId", async (c) => {
    const plan = await loadPlan(db(c.env), runKey(c.env, c.req.param("date")));
    const userId = c.req.param("userId");
    // Only people who appear in this storyboard; the renderer has no Mattermost token.
    const people = new Set([...(plan?.posts ?? []).map((post) => post.userId), ...(plan?.stars ?? []).map((star) => star.userId)]);
    if (!/^[a-z0-9]{26}$/.test(userId) || !people.has(userId)) return c.json({ error: "Avatar not found" }, 404);
    const image = await new MattermostClient(c.env).fetchUserImage(userId);
    if (!image) return c.json({ error: "Avatar not found" }, 404);
    return new Response(image.bytes, { headers: { "Content-Type": image.type, "Cache-Control": "no-store" } });
  });

  app.get("/admin/summary-video/:date/emoji/:name", async (c) => {
    const plan = await loadPlan(db(c.env), runKey(c.env, c.req.param("date")));
    const name = c.req.param("name");
    const used = new Set((plan?.posts ?? []).flatMap((post) => post.reactions.map((reaction) => customEmojiName(reaction.emoji))));
    if (!customEmojiName(`:${name}:`) || !used.has(name)) return c.json({ error: "Emoji not found" }, 404);
    const image = await new MattermostClient(c.env).fetchCustomEmojiImage(name);
    if (!image) return c.json({ error: "Emoji not found" }, 404);
    return new Response(image.bytes, { headers: { "Content-Type": image.type, "Cache-Control": "no-store" } });
  });

  app.put("/admin/summary-video/:date/publish", async (c) => {
    if (c.env.DRY_RUN === "true") return c.json({ error: "Posting is disabled in DRY_RUN" }, 403);
    if (c.req.header("Content-Type") !== "video/mp4") return c.json({ error: "Expected video/mp4" }, 415);
    const date = c.req.param("date"), key = runKey(c.env, date), client = db(c.env);
    const saved = (await client.execute({ sql: "SELECT status, post_id FROM summary_videos WHERE run_id = ?", args: [key] })).rows[0];
    if (saved?.status === "posted") return c.json({ status: "posted", postId: saved.post_id });
    const plan = await loadPlan(client, key);
    if (!plan) return c.json({ error: "Prepare a storyboard first" }, 409);
    // In test-channel mode the video stands alone; in production it must reply to the summary thread.
    const rootId = c.env.VIDEO_TEST_CHANNEL ? undefined : await summaryPostId(c.env, date);
    if (!c.env.VIDEO_TEST_CHANNEL && !rootId) return c.json({ error: "Daily summary is not posted yet" }, 425);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.length > 40 * 1024 * 1024 || bytes.length < 12 ||
      new TextDecoder().decode(bytes.slice(4, 8)) !== "ftyp") return c.json({ error: "Invalid MP4 (maximum 40 MiB)" }, 400);
    const now = new Date(), token = crypto.randomUUID();
    const claimed = await client.execute({
      sql: `UPDATE summary_videos SET status = 'publishing', claim_token = ?, updated_at = ?
        WHERE run_id = ? AND (status = 'ready' OR (status = 'publishing' AND updated_at < ?))`,
      args: [token, now.toISOString(), key, new Date(now.getTime() - 10 * 60 * 1000).toISOString()],
    });
    if (!claimed.rowsAffected) return c.json({ error: "Video delivery is already in progress" }, 409);
    const mm = await videoClient(c.env);
    // If upload/post fails, keep the lease for ten minutes. A retry first reconciles
    // the channel marker, handling an accepted POST whose response was lost.
    let post = await mm.findVideoSummary(date);
    if (!post) {
      const previous = (await client.execute({ sql: "SELECT file_id FROM summary_videos WHERE run_id = ?", args: [key] })).rows[0];
      const fileId = typeof previous?.file_id === "string" ? previous.file_id :
        await mm.uploadSummaryFile(bytes, { name: `mattermost-${date}.mp4`, type: "video/mp4" });
      await client.execute({ sql: "UPDATE summary_videos SET file_id = ? WHERE run_id = ? AND claim_token = ?", args: [fileId, key, token] });
      post = await mm.postVideoSummary(date, videoMessage(plan), fileId, rootId ?? undefined);
    }
    await client.execute({ sql: "UPDATE summary_videos SET status = 'posted', post_id = ?, plan_json = NULL WHERE run_id = ? AND claim_token = ?",
      args: [post.id, key, token] });
    return c.json({ status: "posted", postId: post.id });
  });
}
