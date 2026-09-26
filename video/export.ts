import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chromium } from "playwright";
import ffmpeg from "@ffmpeg-installer/ffmpeg";
import ffprobe from "@ffprobe-installer/ffprobe";
import type { VideoPlan } from "./types";

type TooLong = { index: number; natural: number; window: number };
declare const window: {
    prepareVideo(plan: VideoPlan, audio: string[], avatars: Record<string, string>): Promise<{ tooLong: TooLong[]; duration?: number }>;
    renderFrame(time: number): string;
};

const root = dirname(fileURLToPath(import.meta.url));

// Stills kept for checking a render: hook, a few topics, and the end card.
export const snapshotTimes = (duration: number) =>
  [...new Set([1, ...[0.12, 0.3, 0.55, 0.8].map((f) => Math.round(duration * f)), duration - 1])];

export async function createVideoRenderer(directory: string) {
  let origin = "";
  const audioFile = join(directory, "soundtrack.wav");
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url!, "http://localhost").pathname;
      if (pathname === "/soundtrack" && req.method === "POST") {
        if (req.headers.origin !== origin) { res.writeHead(403).end(); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 12 * 1024 * 1024) { res.writeHead(413).end(); return; }
          chunks.push(chunk);
        }
        await writeFile(audioFile, Buffer.concat(chunks), { mode: 0o600 });
        res.writeHead(204).end(); return;
      }
      const name = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
      const file = resolve(root, name);
      if (!file.startsWith(root + "/") || !/\.(js|html)$/.test(file) || req.method !== "GET") {
        res.writeHead(404).end(); return;
      }
      res.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : "text/html", "Cache-Control": "no-store" });
      res.end(await readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let browser;
  try { browser = await chromium.launch({ headless: true }); }
  catch (error) { server.close(); throw error; }
  const page = await browser.newPage({ viewport: { width: 720, height: 1280 } });
  try {
    await page.goto(origin);
    await page.waitForFunction(() => typeof window.prepareVideo === "function");
  } catch (error) { await browser.close(); server.close(); throw error; }

  return {
    async prepare(plan: VideoPlan, audio: string[], avatars: Record<string, string> = {}) {
      return await page.evaluate(({ plan, audio, avatars }) => window.prepareVideo(plan, audio, avatars), { plan, audio, avatars });
    },
    async export(output: string, duration: number) {
      if (!Number.isInteger(duration) || duration < 8 || duration > 60) throw new Error("Invalid video length");
      const process = spawn(ffmpeg.path, ["-hide_banner", "-loglevel", "error", "-y",
        "-f", "image2pipe", "-vcodec", "mjpeg", "-framerate", "30", "-i", "pipe:0",
        "-i", audioFile, "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", "-t", String(duration), output],
      { stdio: ["pipe", "ignore", "pipe"] });
      let failed: Error | undefined;
      process.on("error", () => { failed = new Error("Could not start FFmpeg"); });
      process.stdin.on("error", () => { failed = new Error("FFmpeg input failed"); });
      process.stderr.resume();
      const finished = new Promise<number | null>((resolve) => process.once("close", resolve));
      try {
        for (let frame = 0; frame < duration * 30; frame += 10) {
          if (failed) throw failed;
          const batch = await page.evaluate((first) => Array.from({ length: 10 }, (_, i) => window.renderFrame((first + i) / 30)), frame);
          for (const data of batch) {
            if (!process.stdin.write(Buffer.from(data, "base64"))) await Promise.race([
              once(process.stdin, "drain"),
              finished.then(() => { throw new Error("FFmpeg stopped during rendering"); }),
            ]);
          }
          if (frame % 300 === 0) console.log(`Rendered ${frame / 30}/${duration} seconds`);
        }
        process.stdin.end();
        if (await finished !== 0) throw new Error("FFmpeg encoding failed");
        for (const time of snapshotTimes(duration)) {
          const frame = await page.evaluate((t) => window.renderFrame(t), time);
          await writeFile(join(directory, `frame-${time}.jpg`), Buffer.from(frame, "base64"), { mode: 0o600 });
        }
        await verifyVideo(output, duration);
      } catch (error) { process.kill("SIGKILL"); await finished; throw error; }
    },
    async close() { await browser.close(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); },
  };
}

export async function verifyVideo(file: string, duration: number) {
  const probe = spawn(ffprobe.path, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]);
  let output = "";
  probe.stdout.on("data", (chunk) => { output += chunk; });
  probe.stderr.resume();
  const [status] = await once(probe, "close");
  if (status !== 0) throw new Error("Could not inspect encoded video");
  const info = JSON.parse(output), video = info.streams.find((s: any) => s.codec_type === "video"),
    audio = info.streams.find((s: any) => s.codec_type === "audio");
  if (video?.codec_name !== "h264" || video.width !== 720 || video.height !== 1280 || video.avg_frame_rate !== "30/1" || audio?.codec_name !== "aac" ||
    Math.abs(Number(info.format.duration) - duration) > 0.1 || Number(info.format.size) > 40 * 1024 * 1024) {
    throw new Error(`Video must be a ${duration}-second 720x1280 H.264/AAC MP4 under 40 MiB`);
  }
}
