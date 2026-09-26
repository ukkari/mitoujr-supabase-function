import { mkdtemp, mkdir, readFile, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { addCalendarDays, jstDate } from "../src/domain/date";
import { createVideoRenderer } from "./export";
import { demoPlan, demoAudio } from "./sample";
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
async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(endpoint + path, { ...init,
    headers: { Authorization: `Bearer ${secret}`, ...init.headers }, redirect: "error",
    signal: AbortSignal.timeout(240_000) });
  if (!response.ok) throw new Error(`Video API ${path} failed (${response.status}); inspect Worker status (private content omitted)`);
  return await response.json() as any;
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
    const audio: string[] = [];
    // Sequential requests keep Gemini quota usage bounded and storyboard edits consistent.
    for (let index = 0; index < plan.scenes.length; index += 1) {
      const result = values.demo ? { audio: demoAudio(), narration: plan.scenes[index].narration } :
        await api(`/audio/${index}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      audio.push(result.audio);
      plan.scenes[index].narration = result.narration;
      console.log(`Narration ${index + 1}/${plan.scenes.length} prepared`);
    }
    for (let attempt = 0; ; attempt += 1) {
      const { tooLong } = await renderer.prepare(plan, audio);
      if (!tooLong.length) break;
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
    await renderer.export(rendered);
    await copyFile(rendered, output);
    if (values.demo) for (const time of [1, 5, 17, 33, 49, 59]) {
      await copyFile(join(directory, `frame-${time}.jpg`), join(resolve(output, ".."), `frame-${time}.jpg`));
    }
    console.log(`Verified 60-second H.264/AAC video: ${output}`);
    if (values.post) {
      const result = await api("/publish", { method: "PUT", headers: { "Content-Type": "video/mp4" }, body: new Uint8Array(await readFile(output)) });
      console.log(JSON.stringify({ date, status: result.status, postId: result.postId }));
    }
  } finally { await renderer.close(); await rm(directory, { recursive: true, force: true }); }
}

main().catch((error) => {
  // Avoid printing fetch stacks, request headers, narration or upstream response bodies.
  console.error(error instanceof Error ? error.message : "Video generation failed");
  process.exitCode = 1;
});
