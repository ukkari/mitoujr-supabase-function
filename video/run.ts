import { mkdtemp, mkdir, readFile, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { addCalendarDays, jstDate } from "../src/domain/date";
import { createVideoRenderer, snapshotTimes } from "./export";
import { demoPlan, demoAudio } from "./sample";
import { customEmojiName } from "./emoji";
import { createVideoApi } from "./api";
import type { VideoPlan } from "./types";

const { values } = parseArgs({ options: {
  date: { type: "string" }, output: { type: "string", default: "dist/video/summary.mp4" },
  post: { type: "boolean", default: false }, demo: { type: "boolean", default: false },
} });
const date = values.date ?? addCalendarDays(jstDate(), -1);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || addCalendarDays(date, 0) !== date) throw new Error("Invalid date");
if (values.demo && values.post) throw new Error("Demo videos cannot be posted");
const base = process.env.VIDEO_API_URL;
const secret = process.env.VIDEO_RUNNER_SECRET || process.env.ADMIN_TRIGGER_SECRET;
if (!values.demo && (!base || !secret)) throw new Error("VIDEO_API_URL and VIDEO_RUNNER_SECRET (or ADMIN_TRIGGER_SECRET) are required");
if (!values.demo && new URL(base!).protocol !== "https:" && !["127.0.0.1", "localhost"].includes(new URL(base!).hostname)) {
  throw new Error("Video API must use HTTPS");
}
const endpoint = `${base?.replace(/\/$/, "")}/admin/summary-video/${date}`;
const api = createVideoApi(endpoint, secret ?? "");

async function image(path: string) {
  try {
    const response = await fetch(`${endpoint}${path}`, { headers: { Authorization: `Bearer ${secret}` },
      redirect: "error", signal: AbortSignal.timeout(30_000) });
    const type = response.headers.get("Content-Type") ?? "";
    if (!response.ok || !/^image\/(png|jpeg|gif|webp)$/.test(type)) { await response.body?.cancel(); return null; }
    return `data:${type};base64,${Buffer.from(await response.arrayBuffer()).toString("base64")}`;
  } catch { return null; }
}

// Avatars and custom emoji come through the Worker (it holds the Mattermost token);
// missing ones fall back to initials / a sparkle.
async function images(plan: VideoPlan) {
  const jobs = [
    ...new Set([...plan.posts.map((post) => post.userId), ...plan.stars.map((star) => star.userId)]),
  ].map((id) => ({ key: id, path: `/avatar/${id}` }));
  const customs = new Set(plan.posts.flatMap((post) => post.reactions.map((r) => customEmojiName(r.emoji))).filter((n): n is string => !!n));
  for (const name of customs) jobs.push({ key: `:${name}:`, path: `/emoji/${encodeURIComponent(name)}` });
  const out: Record<string, string> = {};
  for (let i = 0; i < jobs.length; i += 6) {
    await Promise.all(jobs.slice(i, i + 6).map(async ({ key, path }) => {
      const url = await image(path);
      if (url) out[key] = url;
    }));
  }
  console.log(`Images ${Object.keys(out).length}/${jobs.length} prepared`);
  return out;
}

async function main() {
  const prepared = values.demo ? { status: "ready", plan: demoPlan(date) } : await api("/prepare", { method: "POST" });
  if (prepared.status !== "ready") { console.log(JSON.stringify({ date, status: prepared.status, postId: prepared.postId })); return; }
  const plan: VideoPlan = prepared.plan;
  const directory = await mkdtemp(join(tmpdir(), "mattermost-video-"));
  const output = resolve(values.output!);
  await mkdir(resolve(output, ".."), { recursive: true });
  const renderer = await createVideoRenderer(directory);
  try {
    const faces = values.demo ? {} : await images(plan);
    const audio: string[] = [];
    // Sequential requests keep Gemini quota usage bounded and storyboard edits consistent.
    for (let index = 0; index < plan.scenes.length; index += 1) {
      const result = values.demo ? { audio: demoAudio([...plan.scenes[index].narration].length / 7), narration: plan.scenes[index].narration } :
        await api(`/audio/${index}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      audio.push(result.audio);
      plan.scenes[index].narration = result.narration;
      console.log(`Narration ${index + 1}/${plan.scenes.length} prepared`);
    }
    let duration = 0;
    for (let attempt = 0; ; attempt += 1) {
      const prepared = await renderer.prepare(plan, audio, faces);
      const tooLong = prepared.tooLong;
      if (!tooLong.length) { duration = prepared.duration!; break; }
      if (attempt >= 2 || values.demo) throw new Error("Narration could not fit without cutting speech");
      for (const clip of tooLong) {
        const text = plan.scenes[clip.index].narration;
        const maxChars = Math.max(8, Math.min([...text].length - 1, Math.floor([...text].length * clip.window / clip.natural * .9)));
        const result = await api(`/audio/${clip.index}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ maxChars }) });
        audio[clip.index] = result.audio;
        plan.scenes[clip.index].narration = result.narration;
      }
    }
    const rendered = join(directory, "summary.mp4");
    await renderer.export(rendered, duration);
    await copyFile(rendered, output);
    if (values.demo) for (const time of snapshotTimes(duration)) {
      await copyFile(join(directory, `frame-${time}.jpg`), join(resolve(output, ".."), `frame-${time}.jpg`));
    }
    console.log(`Verified ${duration}-second H.264/AAC video: ${output}`);
    if (values.post) {
      const body = new Uint8Array(await readFile(output));
      // The text summary starts at the same time; wait up to 20 minutes for its thread.
      for (let attempt = 0; ; attempt += 1) {
        const response = await fetch(`${endpoint}/publish`, { method: "PUT", body, redirect: "error",
          headers: { Authorization: `Bearer ${secret}`, "Content-Type": "video/mp4" }, signal: AbortSignal.timeout(240_000) });
        if (response.status === 425 && attempt < 20) {
          await response.body?.cancel();
          console.log("Waiting for the daily summary post…");
          await new Promise((resolve) => setTimeout(resolve, 60_000));
          continue;
        }
        if (!response.ok) throw new Error(`Video API /publish failed (${response.status}); inspect Worker status (private content omitted)`);
        const result = await response.json() as { status: string; postId: string };
        console.log(JSON.stringify({ date, status: result.status, postId: result.postId }));
        break;
      }
    }
  } finally { await renderer.close(); await rm(directory, { recursive: true, force: true }); }
}

main().catch((error) => {
  // Avoid printing fetch stacks, request headers, narration or upstream response bodies.
  console.error(error instanceof Error ? error.message : "Video generation failed");
  process.exitCode = 1;
});
