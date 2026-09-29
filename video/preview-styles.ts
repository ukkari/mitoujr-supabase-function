// Renders stills of every post style from the demo data (no secrets, no audio export).
// npx tsx video/preview-styles.ts [outDir] [style,style,...]
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { once } from "node:events";
import { chromium } from "playwright";
import { validatePlan } from "./gemini";
import { demoAudio, demoDirection, demoSource } from "./sample";

declare const window: any;

const root = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? "dist/video/styles");
const server = createServer(async (req, res) => {
  const path = new URL(req.url!, "http://x").pathname;
  if (path === "/soundtrack") { for await (const _ of req); res.writeHead(204).end(); return; }
  try {
    const file = resolve(root, path === "/" ? "index.html" : path.slice(1));
    res.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : "text/html" });
    res.end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 720, height: 1280 } });
page.on("pageerror", (e) => console.error(e));
await page.goto(`http://127.0.0.1:${(server.address() as any).port}`);
await page.waitForFunction(() => typeof window.prepareVideo === "function");
const styles: string[] = process.argv[3]?.split(",") ?? await page.evaluate(() => window.postStyleIds());
await mkdir(out, { recursive: true });
const counts = [3, 6, 1, 4, 2, 5];
const source = demoSource("2026-09-25"), base = demoDirection();
for (let from = 0; from < styles.length; from += 12) {
  const batch = styles.slice(from, from + 12);
  const raw = { ...base, scenes: batch.map((_, k) => ({ ...base.scenes[k % base.scenes.length],
    posts: Array.from({ length: counts[(from + k) % counts.length] }, (_, n) => ({ id: (k * 5 + n * 3) % 14, quote: "" })) })) };
  const plan = validatePlan(raw, source);
  const audio = plan.scenes.map(() => demoAudio(3));
  const r = await page.evaluate(([p, a, s]) => window.prepareVideo(p, a, {}, { styles: s }), [plan, audio, batch] as const);
  if (r.tooLong?.length) throw new Error("too long");
  for (const [k, name] of batch.entries()) {
    const [start, end] = r.scenes[k];
    for (const [tag, t] of [["in", start + 0.45], ["end", end - 0.1]] as const) {
      const data = await page.evaluate((t) => window.renderFrame(t), t);
      await writeFile(join(out, `${String(from + k + 1).padStart(2, "0")}-${name}-${tag}.jpg`), Buffer.from(data, "base64"));
    }
  }
}
await browser.close(); server.close();
console.log(`${styles.length} styles → ${out}`);
