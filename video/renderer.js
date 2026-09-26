import { setDuration, BEAT } from './vendor/placereel/timeline.js';
import { createKit, E, clamp } from './vendor/placereel/kit.js';
import { pickPalette } from './vendor/placereel/assets.js';
import { ENERGY, kickEnv } from './vendor/placereel/energy.js';
import { overdrive, overdriveTilt } from './vendor/placereel/fx/overdrive.js';
import { TRANSITION } from './vendor/placereel/fx/transition.js';
import { renderSoundtrack } from './vendor/placereel/audio.js';
import { timeStretch } from './vendor/placereel/voice.js';

setDuration(60);
const canvas = document.querySelector('canvas');
const font = '"Noto Sans CJK JP", "Noto Sans JP", "Hiragino Sans", sans-serif';
let render;

function trimSilence(raw, sr) {
  let a = 0, b = raw.length;
  while (a < b && Math.abs(raw[a]) < 0.015) a++;
  while (b > a && Math.abs(raw[b - 1]) < 0.015) b--;
  return raw.slice(Math.max(0, a - sr * 0.02), Math.min(raw.length, b + sr * 0.06));
}

async function prepareAudio(plan, audio) {
  const ctx = new OfflineAudioContext(1, 48000, 48000);
  const speech = [], tooLong = [];
  for (let i = 0; i < plan.scenes.length; i++) {
    const scene = plan.scenes[i];
    const bytes = Uint8Array.from(atob(audio[i]), ch => ch.charCodeAt(0));
    const decoded = await ctx.decodeAudioData(bytes.buffer);
    const sr = decoded.sampleRate;
    const raw = trimSilence(decoded.getChannelData(0), sr);
    if (raw.length < sr * 0.1) throw new Error('Narration is empty or silent');
    const natural = raw.length / sr;
    const start = scene.start + 0.25;
    const window = scene.end - start - 0.35;
    if (natural / window > 1.4) {
      tooLong.push({ index: i, natural, window });
      continue;
    }
    // Finish on an eighth note; never cut a sentence or exceed 1.4x speed.
    const target = Math.min(window, Math.ceil(natural / 1.08 / (BEAT / 2)) * (BEAT / 2));
    const samples = natural > target ? timeStretch(raw, natural / target, sr) : raw;
    const buffer = ctx.createBuffer(1, samples.length, sr);
    buffer.copyToChannel(samples, 0);
    speech.push({ start, dur: samples.length / sr, buffer });
  }
  return { speech, tooLong };
}

function makeRenderer(plan, speech) {
  const model = { seed: Number(plan.date.replaceAll('-', '')), place: { title: '未踏ジュニア', score: 0 },
    keywords: plan.scenes.map(s => ({ word: s.keyword })) };
  const K = createKit(canvas, model, { photos: [], palette: pickPalette([], '', plan.accent) }, { type: 'modern' });
  // Keep the upstream engine intact; override its type theme for Japanese.
  K.theme = Object.fromEntries(['display', 'body', 'mono', 'hand', 'serif'].map(role => [role, { fam: font, w: 800 }]));
  // createKit captures its theme, so override font/caps at the adapter boundary.
  K.font = (_role, size, opts = {}) => {
    K.ctx.font = `${opts.w || 800} ${Math.round(size)}px ${font}`;
    K.ctx.letterSpacing = '0px';
  };
  K.caps = (_role, value) => String(value);
  const { W, H, u } = K;
  const margin = 82 * u;
  const marks = [0, ...plan.scenes.map(s => s.start), 58];

  function block(key, text, y, size, maxLines, color = '#fff', progress = 1) {
    const lay = K.fit(key, text, 'display', W - margin * 2, maxLines, size * u, 28 * u, { lh: 1.38 });
    K.font('display', lay.size);
    K.ctx.textBaseline = 'top';
    const count = Math.ceil(lay.glyphs.length * progress);
    lay.glyphs.forEach((glyph, index) => {
      K.ctx.fillStyle = index < count ? color : 'rgba(255,255,255,.3)';
      K.ctx.fillText(glyph.s, margin + glyph.x, y + glyph.li * lay.lineH);
    });
    return lay.lines.length * lay.lineH;
  }

  function background(t, index) {
    const c = K.ctx;
    const g = c.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#0b142a'); g.addColorStop(1, '#192748');
    K.fill(g);
    const beat = kickEnv(t);
    c.save();
    c.strokeStyle = K.pal.accentSoft; c.lineWidth = 3 * u;
    for (let j = 0; j < 7; j++) {
      c.beginPath(); c.arc(W * .85, H * .43, (170 + j * 62 + beat * 22) * u, t * .18 + j, t * .18 + j + Math.PI * 1.5); c.stroke();
    }
    c.fillStyle = K.pal.accentSoft;
    c.translate(W * .52, H * .47); c.rotate(t * .15 + index);
    c.fillRect(-160 * u, -160 * u, 320 * u, 320 * u);
    c.restore();
    K.fill('rgba(6,12,28,.63)');
  }

  function scene(index, t) {
    const c = K.ctx;
    background(t, index);
    if (index === -1) {
      K.text('mono', 28 * u, '未踏ジュニア / MATTERMOST', margin, H * .24, { color: K.pal.accent });
      block('hook', plan.headline, H * .34, 116, 4);
      K.text('body', 38 * u, `${plan.label === '今日' ? 'きょう' : 'きのう'}の話題を、1分で。`, margin, H * .73);
      return;
    }
    if (index === plan.scenes.length) {
      K.text('mono', 32 * u, 'つづきは Mattermost で', margin, H * .3, { color: K.pal.accent });
      block('outro', '今日の一歩に\nつなげよう。'.replace('\n', ''), H * .4, 114, 3);
      K.text('body', 32 * u, plan.demo ? 'デモ映像 · 音声はテストトーン' : 'AI生成ナレーション · Gemini', margin, H * .69);
      return;
    }
    const s = plan.scenes[index], tau = t - s.start;
    c.save();
    c.translate(0, (1 - E.outExpo(clamp(tau / .4))) * 70 * u);
    K.text('mono', 32 * u, `${String(index + 1).padStart(2, '0')} / ${String(plan.scenes.length).padStart(2, '0')}`, margin, H * .25, { color: K.pal.accent });
    const channel = plan.sources[s.source].name;
    K.text('body', 32 * u, `# ${channel}`, margin, H * .3, { maxW: W - 2 * margin });
    block(`heading-${index}`, s.heading, H * .36, 104, 3);
    const timing = speech[index];
    const progress = clamp((t - timing.start) / timing.dur);
    block(`narration-${index}`, s.narration, H * .62, 48, 7, '#fff', progress);
    c.restore();
  }

  return t => {
    t = clamp(t, 0, 59.999);
    const c = K.main;
    K.ctx = c;
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    K.fill('#080f20');
    const index = t < 2 ? -1 : t >= 58 ? plan.scenes.length : plan.scenes.findIndex(s => t < s.end);
    c.translate(W / 2, H / 2);
    c.rotate(overdriveTilt(t, .012));
    const zoom = 1.035 + .028 * kickEnv(t);
    c.scale(zoom, zoom); c.translate(-W / 2, -H / 2);
    const cut = marks.find(m => m > 0 && t >= m && t < m + .3);
    if (cut !== undefined) {
      TRANSITION[plan.transition].draw(K, (t - cut) / .3,
        () => scene(Math.max(-1, index - 1), t), () => scene(index, t));
    } else scene(index, t);
    // PlaceReel's focus lines, beat sparks, streaks, HUD and cut smears.
    overdrive(K, t, marks);
    c.restore();
    K.fill('rgba(6,12,28,.93)', 0, 0, W, 160 * u);
    K.text('mono', 26 * u, 'MATTERMOST DAILY REEL', margin, 65 * u, { color: K.pal.accent });
    K.text('body', 32 * u, `${plan.date.replaceAll('-', '.')} のまとめ`, margin, 120 * u);
    K.fill('#080f20', 0, H - 58 * u, W, 58 * u);
    K.fill(K.pal.accent, 0, H - 58 * u, W * t / 60, 6 * u);
    K.text('mono', 23 * u, plan.demo ? 'デモ / 架空の話題・テスト音声' : '60秒 / 日本語音声・字幕', margin, H - 18 * u);
  };
}

function wav(buffer) {
  const n = buffer.length, channels = buffer.numberOfChannels;
  const out = new ArrayBuffer(44 + n * channels * 2), view = new DataView(out);
  const text = (at, str) => [...str].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, out.byteLength - 8, true); text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, n * channels * 2, true);
  const data = Array.from({ length: channels }, (_, i) => buffer.getChannelData(i));
  for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) {
    view.setInt16(44 + (i * channels + c) * 2, Math.round(clamp(data[c][i], -1, 1) * 32767), true);
  }
  return out;
}

window.prepareVideo = async (plan, audio) => {
  await document.fonts.ready;
  const { speech, tooLong } = await prepareAudio(plan, audio);
  if (tooLong.length) return { tooLong };
  render = makeRenderer(plan, speech);
  const events = { pops: [], ticks: [], stickers: [], booms: plan.scenes.map(s => s.start),
    scratch: [0], freeze: [], swells: [[57, 58]], zaps: [], voiced: true };
  speech.forEach(s => { for (let t = s.start; t < s.start + s.dur; t += .5) events.pops.push(t); });
  for (let t = .5; t < 58; t += 1) events.zaps.push(t);
  const soundtrack = await renderSoundtrack({ seed: Number(plan.date.replaceAll('-', '')) }, plan.music,
    { energy: ENERGY.dopamine, events, speech });
  const response = await fetch('/soundtrack', { method: 'POST', body: wav(soundtrack) });
  if (!response.ok) throw new Error('Could not save soundtrack');
  return { tooLong: [] };
};
window.renderFrame = t => { render(t); return canvas.toDataURL('image/jpeg', .9).split(',')[1]; };
