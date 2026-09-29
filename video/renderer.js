import { setDuration, BEAT, LENGTHS } from './vendor/placereel/timeline.js';
import { createKit, E, clamp, lerp, seg, TAU, hashN, cover, ellipsize } from './vendor/placereel/kit.js';
import { pickPalette } from './vendor/placereel/assets.js';
import { ENERGY, kickEnv } from './vendor/placereel/energy.js';
import { overdrive, overdriveTilt } from './vendor/placereel/fx/overdrive.js';
import { TRANSITION } from './vendor/placereel/fx/transition.js';
import { renderSoundtrack } from './vendor/placereel/audio.js';
import { timeStretch } from './vendor/placereel/voice.js';
import { createPostStyles } from './post-styles.js';
import { createHeadingStyles } from './heading-styles.js';

const canvas = document.querySelector('canvas');
const font = '"Noto Sans CJK JP", "Noto Sans JP", "Hiragino Sans", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
let render;

const KIND = {
  progress: { label: '🚀 進捗', emoji: ['🚀', '🔥', '💪', '✨', '🎉'] },
  question: { label: '🤔 相談', emoji: ['🤔', '💡', '🙋', '❓', '🧠'] },
  share: { label: '💡 共有', emoji: ['📚', '💡', '👀', '✨', '🙌'] },
  fun: { label: '🎉 盛り上がり', emoji: ['😂', '🎉', '🤣', '✨', '🙌'] },
  news: { label: '📢 お知らせ', emoji: ['📢', '⚡', '👀', '✨', '🗓️'] },
};
// Every cut gets a different transition; the director's pick opens the first topic.
const CUTS = ['band', 'zoom', 'pixel', 'whip', 'iris', 'flash', 'tiles', 'swipe', 'shutter'];
const FREEZE_LEN = 0.5;
const CUT_LEN = 0.24;
// Narration is always sped up hard; scenes are 3–6 s (whole seconds = two beats). Each voice starts
// PRE before its cut and may run POST past the next one, so consecutive voices overlap like a hand-off.
const TEMPO = 1.7, MIN_SPEED = 1.45, MAX_SPEED = 2, PRE = 0.2, POST = 0.15, BODY_MAX = 56;
const MIN_SCENE = 3, MAX_SCENE = 6;

function trimSilence(raw, sr) {
  let a = 0, b = raw.length;
  while (a < b && Math.abs(raw[a]) < 0.015) a++;
  while (b > a && Math.abs(raw[b - 1]) < 0.015) b--;
  return raw.slice(Math.max(0, a - sr * 0.02), Math.min(raw.length, b + sr * 0.06));
}

// Times every scene from its own sped-up voice, so the video is only as long as the day needs.
async function prepareAudio(plan, audio, rollLen) {
  const ctx = new OfflineAudioContext(1, 48000, 48000);
  const clips = [];
  for (let i = 0; i < plan.scenes.length; i++) {
    const bytes = Uint8Array.from(atob(audio[i]), ch => ch.charCodeAt(0));
    const decoded = await ctx.decodeAudioData(bytes.buffer);
    const sr = decoded.sampleRate;
    const raw = trimSilence(decoded.getChannelData(0), sr);
    if (raw.length < sr * 0.1) throw new Error('Narration is empty or silent');
    clips.push({ raw, sr, natural: raw.length / sr });
  }
  const fit = (speed) => clips.map(c => Math.max(MIN_SCENE, Math.ceil(c.natural / speed - PRE - POST)));
  const total = (lens) => lens.reduce((s, b) => s + b, 0);
  const body = BODY_MAX - rollLen;
  let bars = fit(TEMPO);
  if (total(bars) > body) bars = fit(MAX_SPEED);
  // `window` is in unstretched seconds so the runner can shorten the text proportionally.
  const tooLong = [];
  bars.forEach((b, index) => {
    if (b > MAX_SCENE) tooLong.push({ index, natural: clips[index].natural, window: (MAX_SCENE + PRE + POST) * MAX_SPEED });
  });
  if (!tooLong.length && total(bars) > body) {
    const longest = bars.map((b, index) => ({ b, index })).filter(x => x.b > MIN_SCENE).sort((a, b) => b.b - a.b);
    for (let over = total(bars) - body; over > 0 && longest.length;) {
      const { index, b } = longest.shift();
      tooLong.push({ index, natural: clips[index].natural, window: (MIN_SCENE + PRE + POST) * MAX_SPEED });
      over -= b - MIN_SCENE;
    }
  }
  if (tooLong.length) return { tooLong };
  let t = 2;
  plan.scenes.forEach((s, i) => { s.start = t; s.end = t + bars[i]; t = s.end; });
  // Whole-second scenes can leave an odd total; the end lands on a bar so the score resolves cleanly.
  if (t % 2) { plan.scenes.at(-1).end += 1; t += 1; }
  if (t < 10) { plan.scenes.at(-1).end += 10 - t; t = 10; }
  t += rollLen;
  const speech = clips.map((c, i) => {
    // Fill the slot (never slower than MIN_SPEED) so the next voice cuts in over this one's tail.
    const s = plan.scenes[i], start = s.start - PRE;
    const speed = clamp(c.natural / (s.end + POST - start), MIN_SPEED, MAX_SPEED);
    const samples = timeStretch(c.raw, speed, c.sr);
    const buffer = ctx.createBuffer(1, samples.length, c.sr);
    buffer.copyToChannel(samples, 0);
    return { start, dur: samples.length / c.sr, buffer };
  });
  return { speech, tooLong, duration: t + 2 };
}

// Active channels that no scene features: named in a quick roll call before the end card.
function rollCall(plan) {
  const featured = new Set(plan.scenes.flatMap(s => [s.source, ...(s.posts ?? []).map(id => plan.posts?.[id]?.channel)]));
  return plan.sources.map((src, index) => ({ ...src, index })).filter(src => !featured.has(src.index) && src.posts !== 0)
    .sort((a, b) => (b.posts ?? 0) - (a.posts ?? 0));
}
const ROLL_LEN = 4, ROLL_SHOWN = 12, rollAt = (k) => 0.25 + k * BEAT / 4;

const emojiOf = (plan, i) => (plan.scenes[i].emoji?.length ? plan.scenes[i].emoji : (KIND[plan.scenes[i].kind] ?? KIND.progress).emoji);

// One cue sheet drives both picture and sound: card slams, reaction pops, stickers, freeze.
function cueSheet(plan) {
  const posts = plan.posts ?? [];
  const scenes = plan.scenes.map((s) => {
    const D = s.end - s.start, ids = (s.posts ?? []).filter((id) => posts[id]);
    const step = ids.length > 1 ? clamp(Math.floor((D - 1.5) / ids.length / 0.25) * 0.25, 0.25, 1) : 0;
    const cards = ids.map((id, j) => {
      const at = s.start + 0.35 + j * step, p = posts[id];
      const chips = p.reactions.length + (p.replies ? 1 : 0);
      return { id, at, chips: Array.from({ length: chips }, (_, k) => at + 0.3 + k * BEAT / 8) };
    });
    const stickers = [0.25, Math.round(D * 2) / 4, D - 1].map((dt, k) => ({ at: s.start + dt, k }));
    return { cards, stickers };
  });
  // Freeze-frame + boom on the most-reacted post of the day.
  let freeze = null, best = 2;
  scenes.forEach((sc, i) => sc.cards.forEach((card) => {
    const total = posts[card.id].reactions.reduce((n, r) => n + r.count, 0);
    const at = Math.ceil(((card.chips.at(-1) ?? card.at) + 0.25) / 0.25) * 0.25;
    if (total > best && at + FREEZE_LEN + 0.15 < plan.scenes[i].end) { best = total; freeze = { at, scene: i, post: card.id, total }; }
  }));
  return { scenes, freeze };
}

const hashStr = (s) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);

function makeRenderer(plan, speech, faces, cues, duration, roll, options = {}) {
  const seed = Number(plan.date.replaceAll('-', ''));
  const model = { seed, place: { title: '未踏ジュニア', score: 0 }, keywords: plan.scenes.map(s => ({ word: s.keyword })) };
  const K = createKit(canvas, model, { photos: [], palette: pickPalette([], '', plan.accent) }, { type: 'modern' });
  // Keep the upstream engine intact; override its type theme for Japanese + emoji.
  K.theme = Object.fromEntries(['display', 'body', 'mono', 'hand', 'serif'].map(role => [role, { fam: font, w: 800 }]));
  K.font = (_role, size, opts = {}) => {
    K.ctx.font = `${opts.w || 800} ${Math.round(size)}px ${font}`;
    K.ctx.letterSpacing = '0px';
  };
  K.caps = (_role, value) => String(value);
  const { W, H, u, pal } = K;
  const X = (v) => v * u;
  const M = X(64);
  const N = plan.scenes.length;
  const END = duration - 2, ROLL = roll.length ? END - ROLL_LEN : END;
  const posts = plan.posts ?? [];
  const stars = (plan.stars ?? []).slice(0, 8);
  const dayEmoji = plan.emoji?.length ? plan.emoji : ['🔥', '🎉', '✨'];
  const when = plan.label === '今日' ? 'きょう' : 'きのう';
  const marks = [0, ...plan.scenes.map(s => s.start), ...(roll.length ? [ROLL] : []), END];
  const cutKind = marks.map((m, k) => (k === 1 ? plan.transition : m === END ? 'zoom' : CUTS[(k + seed) % CUTS.length]));
  const hue = (i) => pal.hue + (i + 1) * 47;
  const col = (i, l = 62, a = 1) => pal.hsl(hue(i), 95, l, a);
  // -1 hook, 0..N-1 topics, N roll call, N+1 end card.
  const at = (t) => (t < 2 ? -1 : t >= END ? N + 1 : t >= ROLL ? N : plan.scenes.findIndex(s => t < s.end));
  const nameOf = (userId) => stars.find(s => s.userId === userId)?.user ?? posts.find(p => p.userId === userId)?.user ?? '#';
  K.hits = [{ t: 0, amp: 0.7 }, { t: 2, amp: 0.6 }, ...plan.scenes.slice(1).map(s => ({ t: s.start, amp: 0.45 })),
    ...(cues.freeze ? [{ t: cues.freeze.at, amp: 0.8 }] : []), { t: END, amp: 1 }];

  const rr = (x, y, w, h, r) => { K.ctx.beginPath(); K.ctx.roundRect(x, y, w, h, r); };

  // ---------- emoji: pre-rendered sprites so hundreds per frame stay cheap and crisp
  const sprites = new Map();
  function sprite(ch) {
    if (!sprites.has(ch)) {
      const S = 320, off = new OffscreenCanvas(S, S), x = off.getContext('2d'), custom = ch.startsWith(':') ? faces[ch] : null;
      if (custom) {
        const k = Math.min(S * 0.86 / custom.width, S * 0.86 / custom.height);
        x.drawImage(custom, (S - custom.width * k) / 2, (S - custom.height * k) / 2, custom.width * k, custom.height * k);
      } else {
        x.font = `${S * 0.8}px ${font}`; x.textAlign = 'center'; x.textBaseline = 'middle';
        x.fillText(ch.startsWith(':') ? '✨' : ch, S / 2, S * 0.54);
      }
      sprites.set(ch, off);
    }
    return sprites.get(ch);
  }
  function emo(ch, x, y, size, rot = 0, alpha = 1) {
    if (size <= 0.5 || alpha <= 0.01) return;
    const c = K.ctx;
    c.save();
    c.globalAlpha *= alpha;
    c.translate(x, y); c.rotate(rot);
    c.drawImage(sprite(ch), -size / 2, -size / 2, size, size);
    c.restore();
  }
  // Radial explosion with gravity.
  function burst(t, t0, x, y, list, n, s, power = 1) {
    const q = t - t0;
    if (q < 0 || q > 0.9) return;
    for (let k = 0; k < n; k++) {
      const r = (j) => hashN(s * 131 + k * 17 + j);
      const a = r(1) * TAU, v = X(500 + 1000 * r(2)) * power;
      const size = X(56 + 70 * r(3)) * (1 + 0.6 * (1 - E.outCubic(clamp(q * 5))));
      emo(list[k % list.length], x + Math.cos(a) * v * q, y + Math.sin(a) * v * q + X(1500) * q * q, size, (r(4) - 0.5) * 8 * q, clamp((0.9 - q) * 3));
    }
  }
  // Live-stream style reactions floating up from a post.
  function fountain(t, t0, dur, x, y, list, s) {
    const step = 0.09, last = Math.floor((t - t0) / step);
    for (let k = Math.max(0, last - 14); k <= last; k++) {
      const born = t0 + k * step, age = t - born;
      if (born > t0 + dur || age < 0 || age > 1.25) continue;
      const r = (j) => hashN(s * 97 + k * 13 + j);
      emo(list[k % list.length], x + (r(1) - 0.5) * X(160) + Math.sin(age * 5 + k) * X(34), y - age * X(560),
        X(50 + 30 * r(2)) * E.outBack(clamp(age * 5), 2.4), Math.sin(age * 4 + k) * 0.3, clamp((1.25 - age) * 2.5));
    }
  }
  function rain(t, t0, list, n, s) {
    const q = t - t0;
    if (q < 0) return;
    for (let k = 0; k < n; k++) {
      const r = (j) => hashN(s * 71 + k * 19 + j);
      const y = -X(120) + (q - r(1) * 0.8) * X(1500 + 700 * r(2));
      if (y < -X(120) || y > H + X(120)) continue;
      emo(list[k % list.length], r(3) * W, y, X(70 + 60 * r(4)), Math.sin(q * 3 + k) * 0.5);
    }
  }
  // Scrolling emoji wallpaper, one tile per scene.
  const tiles = new Map();
  function wallpaper(t, i, list) {
    const c = K.ctx, T = Math.round(X(300));
    if (!tiles.has(i)) {
      const off = new OffscreenCanvas(T, T), x = off.getContext('2d');
      [[0.25, 0.25], [0.75, 0.75]].forEach(([a, b], k) => x.drawImage(sprite(list[(k + Math.max(0, i)) % list.length]), a * T - T * 0.18, b * T - T * 0.18, T * 0.36, T * 0.36));
      tiles.set(i, c.createPattern(off, 'repeat'));
    }
    c.save();
    c.globalAlpha = 0.13 + 0.1 * kickEnv(t);
    c.translate(W / 2, H / 2); c.rotate(-0.25); c.scale(1 + 0.04 * kickEnv(t), 1 + 0.04 * kickEnv(t));
    c.translate((t * X(140)) % T, (t * X(90)) % T);
    c.fillStyle = tiles.get(i);
    c.fillRect(-H - T, -H - T, 2 * H + 2 * T, 2 * H + 2 * T);
    c.restore();
  }

  // Meme-style type: thick black outline, per-glyph pop, keyword marker.
  function popText(lay, x, y, tau, { start = 0, step = 0.045, color = '#fff', hl = null, align = 'left', maxW = W - 2 * M } = {}) {
    const c = K.ctx, units = new Map();
    lay.glyphs.forEach((g) => { if (!units.has(g.i0)) units.set(g.i0, units.size); });
    K.font('display', lay.size, lay.opts);
    c.textBaseline = 'top'; c.lineJoin = 'round';
    for (const pass of ['stroke', 'fill']) {
      lay.glyphs.forEach((g) => {
        const a = start + units.get(g.i0) * step, raw = seg(tau, a, a + 0.14);
        if (raw <= 0) return;
        const s = E.outBack(raw, 3);
        const gx = K.lineX(lay, g.li, x, maxW, align) + g.x, gy = y + g.li * lay.lineH;
        c.save();
        c.translate(gx + g.w / 2, gy + lay.size / 2); c.scale(s, s); c.translate(-(gx + g.w / 2), -(gy + lay.size / 2));
        if (pass === 'stroke') { c.strokeStyle = '#000'; c.lineWidth = lay.size * 0.2; c.strokeText(g.s, gx, gy); }
        else { c.fillStyle = hl && g.i0 >= hl[0] && g.i0 < hl[1] ? '#ffe100' : color; c.fillText(g.s, gx, gy); }
        c.restore();
      });
    }
  }
  const headLay = (i) => K.fit(`h${i}`, plan.scenes[i].heading, 'display', W - 2 * M, 2, X(110), X(56), { lh: 1.2 });
  const hookLay = () => K.fit('hook', plan.headline, 'display', W - 2 * M, 3, X(124), X(60), { lh: 1.2 });

  function face(userId, name, x, y, r, ring) {
    const c = K.ctx, img = faces[userId];
    c.save();
    c.beginPath(); c.arc(x, y, r, 0, TAU);
    if (img) { c.clip(); cover(c, img, x - r, y - r, 2 * r, 2 * r); }
    else {
      c.fillStyle = pal.hsl(hashStr(userId) % 360, 70, 46); c.fill();
      K.text('display', r * 1.05, [...(name || '?')][0].toUpperCase(), x, y + r * 0.08, { align: 'center', baseline: 'middle' });
    }
    c.restore();
    c.beginPath(); c.arc(x, y, r + X(4), 0, TAU);
    c.strokeStyle = ring; c.lineWidth = X(6); c.stroke();
  }

  const postStyles = createPostStyles({ K, X, W, H, plan, posts, seed, col, rr, face, emo });
  const styleOrder = options.styles?.length ? options.styles : postStyles.order();
  const styleOf = (i) => styleOrder[i % styleOrder.length];
  // Headings get their own entrance/effect per scene (-1 is the hook headline), also shuffled per day.
  const headingStyles = createHeadingStyles({ K, X, W, col, seed });
  const headingOrder = options.headings?.length ? options.headings : headingStyles.order();
  const headingOf = (i) => headingOrder[(i + 1) % headingOrder.length];

  function background(t, i, list) {
    const c = K.ctx, k = kickEnv(t);
    K.fill(K.gradient([[0, pal.hsl(hue(i), 60, 9)], [1, pal.hsl(hue(i) + 40, 70, 17)]], 0, 0, W, H));
    c.save();
    c.globalCompositeOperation = 'lighter';
    [[0.2, 0.25], [0.85, 0.6], [0.35, 0.92]].forEach(([x, y], j) => {
      c.fillStyle = K.radial(W * x + Math.sin(t * 0.9 + j) * X(90), H * y + Math.cos(t * 0.7 + j) * X(90),
        X(560 + 120 * k), pal.hsl(hue(i) + j * 30, 95, 55, 0.2 + 0.15 * k));
      c.fillRect(0, 0, W, H);
    });
    c.restore();
    wallpaper(t, i, list);
    if (i >= 0 && i < N) postStyles.wall(t, i);
  }

  function confetti(t, t0, n, s) {
    const q = t - t0;
    if (q < 0 || q > 2.2) return;
    const c = K.ctx;
    for (let k = 0; k < n; k++) {
      const r = (j) => hashN(s * 977 + k * 13 + j);
      const x = W * (0.15 + 0.7 * r(3)) + (r(1) - 0.5) * X(1500) * q;
      const y = H * 0.5 - X(900 + 1000 * r(2)) * q + X(1700) * q * q;
      c.save();
      c.translate(x, y); c.rotate(q * (4 + 8 * r(4)));
      c.globalAlpha = clamp(2.2 - q);
      c.fillStyle = pal.hsl(r(5) * 360, 95, 62);
      c.fillRect(-X(12), -X(6), X(24), X(12) * (0.4 + Math.abs(Math.sin(q * 9 + k))));
      c.restore();
    }
  }

  function hook(t) {
    const c = K.ctx;
    background(t, -1, dayEmoji);
    K.pill(M, X(210), `${when}の MATTERMOST ⚡`, { size: 32, w: 900, bg: pal.accent, fg: '#000', scaleX: E.outBack(seg(t, 0, 0.2)) });
    burst(t, 0.28, W / 2, X(470), dayEmoji, 26, 5, 1.1);
    // Headline slams in, then bounces on the kick.
    const lay = hookLay(), p = seg(t, 0.04, 0.3);
    if (p > 0) {
      const top = X(320), cy = top + lay.lines.length * lay.lineH / 2;
      c.save();
      c.translate(W / 2, cy); c.rotate(-0.035);
      const s = lerp(2.6, 1, E.outBack(p, 1.8)) * (1 + 0.03 * kickEnv(t));
      c.scale(s, s); c.translate(-W / 2, -cy);
      headingStyles.draw(headingOf(-1), lay, M, top, t, t, -1);
      c.restore();
    }
    const st = plan.stats;
    if (st) {
      const items = [['📝', '投稿', st.posts], ['📺', 'チャンネル', st.channels], ['👥', 'メンバー', st.people], ['🔥', 'リアクション', st.reactions]];
      const gap = X(18), tw = (W - 2 * M - 3 * gap) / 4, y = X(1000);
      items.forEach(([icon, label, n], k) => {
        const a = 0.35 + k * 0.1, e = E.outBack(seg(t, a, a + 0.22), 2.5);
        if (e <= 0) return;
        const x = M + k * (tw + gap);
        c.save();
        c.translate(x + tw / 2, y + X(125)); c.rotate((k - 1.5) * 0.04); c.scale(e, e); c.translate(-(x + tw / 2), -(y + X(125)));
        rr(x, y, tw, X(250), X(36)); c.fillStyle = k === 1 ? pal.accent : '#fff'; c.fill();
        emo(icon, x + tw / 2, y - X(10), X(90) * (1 + 0.2 * kickEnv(t)), (k - 1.5) * 0.2);
        K.text('display', X(74), K.fmt(n * E.outCubic(seg(t, a, a + 0.7))), x + tw / 2, y + X(150), { align: 'center', color: '#000', w: 900, maxW: tw - X(16) });
        K.text('body', X(26), label, x + tw / 2, y + X(212), { align: 'center', color: '#000', maxW: tw - X(12) });
        c.restore();
      });
    }
    stars.slice(0, 7).forEach((s, k, arr) => {
      const e = E.outBack(seg(t, 0.55 + k * 0.06, 0.85 + k * 0.06), 2);
      if (e <= 0) return;
      const mid = (arr.length - 1) / 2;
      const x = W / 2 + (k - mid) * X(134);
      const y = lerp(H + X(140), X(1450) + Math.abs(k - mid) * X(26), e) - kickEnv(t, 10) * X(20) * (k % 2 ? 1 : 0.5);
      face(s.userId, s.user, x, y, X(58), col(k));
    });
    if (t > 1) K.text('body', X(38), `${when}の話題を、一気見 ${dayEmoji[0]}`, W / 2, X(1640), { align: 'center' });
  }

  function outro(t) {
    const c = K.ctx, tau = t - END;
    background(t, N + 1, dayEmoji);
    rain(t, END, [...dayEmoji, '🎉', '🙌'], 36, 9);
    K.pill(W / 2, X(250), `${when}を盛り上げたみんな 🙌`, { align: 'center', size: 36, w: 900, bg: pal.accent, fg: '#000', scaleX: E.outBack(seg(tau, 0, 0.2)) });
    stars.forEach((s, k) => {
      const e = E.outBack(seg(tau, 0.08 + k * 0.05, 0.35 + k * 0.05), 2.2);
      if (e <= 0) return;
      const cx = W / 2 + ((k % 4) - 1.5) * X(230), cy = X(560) + Math.floor(k / 4) * X(290) - kickEnv(t, 10) * X(16) * ((k % 2) ? 1 : 0.4);
      c.save();
      c.translate(cx, cy); c.scale(e, e); c.translate(-cx, -cy);
      face(s.userId, s.user, cx, cy, X(84), col(k));
      K.text('body', X(30), `@${s.user}`, cx, cy + X(136), { align: 'center', maxW: X(215) });
      c.restore();
    });
    const lay = K.fit('outro', 'つづきは Mattermost で！', 'display', W - 2 * M, 2, X(104), X(56), { lh: 1.2 });
    popText(lay, M, X(1180), tau, { start: 0.4, step: 0.04, align: 'center' });
    if (tau > 0.8) K.text('body', X(34), '元の投稿へのリンクは本文にあります 👇', W / 2, X(1520), { align: 'center', color: pal.accent });
  }

  function postCard(p, card, x, y, w, h, t, i, fresh) {
    const c = K.ctx, since = t - card.at;
    c.save();
    c.shadowColor = 'rgba(0,0,0,.5)'; c.shadowBlur = X(34); c.shadowOffsetY = X(14);
    rr(x, y, w, h, X(30)); c.fillStyle = '#fff'; c.fill();
    c.restore();
    c.save();
    rr(x, y, w, h, X(30)); c.clip();
    K.fill(col(i), x, y, X(14), h);
    c.restore();
    const glow = Math.exp(-since * 3) + (fresh ? 0.3 * kickEnv(t, 10) : 0);
    if (glow > 0.02) { rr(x, y, w, h, X(30)); c.strokeStyle = col(i, 62, clamp(glow)); c.lineWidth = X(10); c.stroke(); }
    const r = X(42);
    face(p.userId, p.user, x + X(40) + r, y + X(30) + r, r, col(i));
    const nx = x + X(150);
    const nw = K.text('body', X(32), `@${p.user}`, nx, y + X(64), { color: '#111', w: 900, maxW: w * 0.42 });
    const where = p.channel !== plan.scenes[i].source && plan.sources[p.channel] ? ` · #${plan.sources[p.channel].name}` : '';
    K.text('body', X(26), `${p.time}${where}`, nx + nw + X(14), y + X(64), { color: '#888', w: 600, maxW: w - (nx - x) - nw - X(30) });
    // Quote types itself out right after the slam.
    const area = h - X(92), fs = Math.min(X(42), area / 2 / 1.28);
    const lines = Math.max(1, Math.floor(area / (fs * 1.28)));
    const lay = K.fit(`c${card.id}-${Math.round(h)}`, p.text, 'body', w - (nx - x) - X(28), lines, fs, X(24), { w: 700, lh: 1.28 });
    const upto = Math.ceil(lay.glyphs.length * seg(since, 0.05, 0.05 + Math.min(0.35, lay.glyphs.length * 0.012)));
    K.font('body', lay.size, lay.opts);
    c.textBaseline = 'top'; c.fillStyle = '#111';
    lay.glyphs.slice(0, upto).forEach((g) => c.fillText(g.s, nx + g.x, y + X(84) + g.li * lay.lineH));
    // Reaction / reply badges pop onto the card's top-right edge.
    const chips = [...p.reactions.map(r => [r.emoji, r.count]), ...(p.replies ? [['💬', p.replies]] : [])];
    let cx = x + w - X(18);
    chips.forEach(([emoji, count], k) => {
      const a = card.chips[k], e = E.outBack(seg(t, a, a + 0.16), 3.2);
      K.font('body', X(30), { w: 900 });
      const cw = c.measureText(`${count}`).width + X(96);
      cx -= cw;
      if (e <= 0) { cx -= X(10); return; }
      const cy = y - X(28);
      c.save();
      c.translate(cx + cw / 2, cy + X(28)); c.scale(e, e); c.rotate(0.06 * (k % 2 ? 1 : -1)); c.translate(-(cx + cw / 2), -(cy + X(28)));
      rr(cx, cy, cw, X(56), X(28)); c.fillStyle = k === 0 ? '#ffe100' : '#fff'; c.fill();
      c.strokeStyle = '#000'; c.lineWidth = X(4); c.stroke();
      emo(emoji, cx + X(36), cy + X(28), X(44) * (1 + 0.35 * Math.exp(-(t - a) * 6)));
      K.text('body', X(30), String(Math.max(1, Math.round(count * E.outCubic(seg(t, a, a + 0.35))))), cx + X(66), cy + X(30), { color: '#000', baseline: 'middle', w: 900 });
      c.restore();
      cx -= X(10);
    });
  }

  function scene(i, t) {
    const c = K.ctx, s = plan.scenes[i], cue = cues.scenes[i], tau = t - s.start, list = emojiOf(plan, i);
    background(t, i, list);
    const kind = KIND[s.kind] ?? KIND.progress;
    const cw = K.pill(M, X(175), `${String(i + 1).padStart(2, '0')}/${String(N).padStart(2, '0')}`, { size: 30, w: 900, bg: '#fff', fg: '#000', scaleX: E.outBack(seg(tau, 0, 0.2)) });
    // Kind badge is stamped on (scale 3 → 1 with a tilt).
    const se = seg(tau, 0.18, 0.34);
    if (se > 0) {
      const bx = M + cw + X(20), by = X(175), sc = lerp(3, 1, E.outBack(se, 2));
      c.save();
      c.translate(bx + X(110), by + X(32)); c.rotate(-0.08); c.scale(sc, sc); c.translate(-(bx + X(110)), -(by + X(32)));
      K.pill(bx, by, kind.label, { size: 30, w: 900, bg: col(i), fg: '#000', stroke: '#000' });
      c.restore();
    }
    // Channel name is big: it is what viewers use to find the thread afterwards.
    K.font('body', X(52), { w: 900 });
    const channel = ellipsize(c, `# ${plan.sources[s.source]?.name ?? ''}`, W - 2 * M - X(230));
    const ce = E.outBack(seg(tau, 0.04, 0.24), 2.2);
    if (ce > 0) {
      c.save();
      c.translate(M, X(300)); c.rotate(-0.025 * ce); c.scale(lerp(1.8, 1, ce), lerp(1.8, 1, ce)); c.translate(-M, -X(300));
      K.pill(M, X(248), channel, { size: 52, h: 104, w: 900, bg: '#000', fg: col(i, 70), stroke: col(i) });
      c.restore();
    }
    // Heading: word pops with the keyword highlighted, pulsing on the kick.
    const lay = headLay(i), k0 = s.heading.indexOf(s.keyword);
    const top = X(385), cy = top + lay.lines.length * lay.lineH / 2, pulse = 1 + 0.03 * kickEnv(t);
    c.save();
    c.translate(W / 2, cy); c.scale(pulse, pulse); c.translate(-W / 2, -cy);
    headingStyles.draw(headingOf(i), lay, M, top, tau, t, i, { hl: k0 >= 0 ? [k0, k0 + s.keyword.length] : null });
    c.restore();
    // Giant topic emoji smashes in, then parks top-right and bounces on the beat.
    const e1 = E.outBack(seg(tau, 0, 0.2), 2.4), m = E.inOutCubic(seg(tau, 0.3, 0.5));
    if (e1 > 0) {
      emo(list[0], lerp(W / 2, W - X(118), m), lerp(H * 0.48, X(210), m) - kickEnv(t, 10) * X(18) * m,
        lerp(X(620), X(150), m) * e1 * (1 + 0.12 * kickEnv(t) * m), lerp(-0.5 * (1 - e1), 0.14 * Math.sin(t * 5), m));
    }
    // Original posts, in this scene's presentation style, filling the space under the heading.
    const areaTop = top + lay.lines.length * lay.lineH + X(44);
    const latest = cue.cards.reduce((mx, card, j) => (t >= card.at ? j : mx), -1);
    const spots = postStyles.STYLES[styleOf(i)]({
      t, i, list, latest, start: s.start, end: s.end, A: { x: M, y: areaTop, w: W - 2 * M, h: X(1820) - areaTop },
      items: cue.cards.map((card, j) => ({ card, p: posts[card.id], j })),
    });
    // Emoji on every slam, and reactions streaming up like a live stream.
    spots.forEach(({ card, x, y, w, h }, j) => {
      const p = posts[card.id], own = p.reactions.map(r => r.emoji);
      burst(t, card.at + 0.12, x + w / 2, y + h / 2, own.length ? [...own, ...list] : list, 14, seed + i * 7 + j, 0.8);
      const total = p.reactions.reduce((sum, r) => sum + r.count, 0);
      if (own.length && card.chips.length) fountain(t, card.chips[0], Math.min(2.2, 0.09 * total), x + w - X(120), y, own, seed + i * 11 + j);
    });
    cue.stickers.forEach((st) => {
      const since = t - st.at;
      if (since < 0) return;
      const r = (j) => hashN(seed + i * 31 + st.k * 7 + j);
      const x = r(1) < 0.5 ? X(80) + r(2) * X(70) : W - X(80) - r(2) * X(70);
      emo(list[(st.k + 1) % list.length], x, X(740) + r(3) * X(1000), X(150) * E.outBack(seg(since, 0, 0.2), 3) * (1 + 0.14 * kickEnv(t)),
        (r(5) - 0.5) * 0.7 + Math.sin(t * 6 + st.k) * 0.14);
    });
  }

  function rollFrame(t) {
    const c = K.ctx, tau = t - ROLL, shown = roll.slice(0, ROLL_SHOWN);
    background(t, N, ['📣', '💬', '👀', '✨']);
    K.pill(W / 2, X(200), `ほかにも ${roll.length} チャンネルで動きあり！`, { align: 'center', size: 40, w: 900, bg: pal.accent, fg: '#000', scaleX: E.outBack(seg(tau, 0, 0.2)) });
    const gap = X(20), cw = (W - 2 * M - gap) / 2, rows = Math.ceil(shown.length / 2), top = X(340);
    const ch = Math.min(X(190), (X(1500) - top - gap * (rows - 1)) / rows);
    const spot = (k) => [M + (k % 2) * (cw + gap), top + Math.floor(k / 2) * (ch + gap)];
    shown.forEach((src, k) => {
      const a = rollAt(k), e = E.outBack(seg(tau, a, a + 0.2), 2.4);
      if (e <= 0) return;
      const [x, y] = spot(k), r = Math.min(X(46), ch * 0.3);
      c.save();
      c.translate(x + cw / 2, y + ch / 2); c.rotate((k % 2 ? 1 : -1) * 0.025); c.scale(e, e); c.translate(-(x + cw / 2), -(y + ch / 2));
      rr(x, y, cw, ch, X(26)); c.fillStyle = '#fff'; c.fill();
      c.save(); rr(x, y, cw, ch, X(26)); c.clip(); K.fill(col(k), x, y, X(12), ch); c.restore();
      if (src.top) face(src.top, nameOf(src.top), x + X(28) + r, y + ch / 2, r, col(k));
      const tx = x + X(48) + 2 * r;
      K.text('body', X(34), `#${src.name}`, tx, y + ch / 2 - X(4), { color: '#111', w: 900, maxW: x + cw - tx - X(14) });
      if (src.posts) K.text('body', X(26), `💬 ${src.posts}件 · ${src.people}人`, tx, y + ch / 2 + X(40), { color: '#666', w: 700 });
      c.restore();
    });
    shown.forEach((_, k) => { const [x, y] = spot(k); burst(t, ROLL + rollAt(k), x + cw / 2, y + ch / 2, ['💬', '✨', '👀'], 5, seed + k, 0.5); });
    if (roll.length > shown.length) K.text('display', X(44), `＋${roll.length - shown.length} チャンネル`, W / 2, X(1560), { align: 'center' });
  }

  function frame(i, t) {
    if (i < 0) hook(t); else if (i < N) scene(i, t); else if (i === N) rollFrame(t); else outro(t);
  }

  function freezeStamp(q, fz) {
    const c = K.ctx, e = E.outBack(seg(q, 0.02, 0.18), 2.5);
    if (e <= 0) return;
    const top = posts[fz.post].reactions[0]?.emoji ?? '🔥';
    burst(q, 0.02, W / 2, H * 0.44, [top], 34, 77, 1.3);
    const label = `リアクション ×${fz.total}!!`;
    K.font('display', X(84), { w: 900 });
    const w = c.measureText(label).width + X(200), fit = Math.min(1, (W - 2 * M) / w);
    c.save();
    c.translate(W / 2, H * 0.44); c.rotate(-0.08); c.scale(e * fit, e * fit);
    rr(-w / 2, -X(80), w, X(160), X(40)); c.fillStyle = '#ffe100'; c.fill();
    c.strokeStyle = '#000'; c.lineWidth = X(10); c.stroke();
    emo(top, -w / 2 + X(90), 0, X(120) * (1 + 0.3 * Math.exp(-q * 8)), -0.2);
    K.text('display', X(84), label, X(50), X(8), { align: 'center', baseline: 'middle', color: '#000', w: 900 });
    c.restore();
  }

  function chrome(t) {
    const c = K.ctx;
    K.fill(K.gradient([[0, 'rgba(0,0,0,.7)'], [1, 'rgba(0,0,0,0)']], 0, 0, 0, X(170)), 0, 0, W, X(170));
    const segs = [[0, 2], ...plan.scenes.map(s => [s.start, s.end]), ...(roll.length ? [[ROLL, END]] : []), [END, duration]];
    const gap = X(8), sw = (W - X(72) - gap * (segs.length - 1)) / segs.length;
    segs.forEach(([a, b], k) => {
      const x = X(36) + k * (sw + gap);
      K.fill('rgba(255,255,255,.3)', x, X(34), sw, X(9));
      K.fill('#fff', x, X(34), sw * clamp((t - a) / (b - a)), X(9));
    });
    K.text('body', X(30), `${plan.date.replaceAll('-', '.')} のまとめ`, X(36), X(102), { w: 800 });
    K.text('body', X(26), 'MATTERMOST DAILY', W - X(36), X(102), { align: 'right', color: pal.accent, w: 900 });
    c.globalAlpha = 0.75;
    K.text('body', X(22), plan.demo ? 'デモ / 架空の投稿・テスト音声' : 'AI要約・読み上げ（Gemini）', W / 2, H - X(28), { align: 'center', w: 600 });
    c.globalAlpha = 1;
  }

  const draw = (t) => {
    t = clamp(t, 0, duration - 0.001);
    const c = K.main;
    K.ctx = c;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1; c.globalCompositeOperation = 'source-over'; c.filter = 'none';
    K.fill('#000');
    const index = at(t), fz = cues.freeze && t >= cues.freeze.at && t < cues.freeze.at + FREEZE_LEN ? cues.freeze : null;
    const hit = K.hit(t), jolt = Math.floor(t * 30);
    c.save();
    c.translate(W / 2, H / 2);
    c.rotate(overdriveTilt(t, 0.03) + (fz ? 0.025 : 0));
    const zoom = 1.04 + 0.045 * kickEnv(t) + (fz ? 0.05 * E.outBack(seg(t - fz.at, 0, 0.15), 2) : 0);
    c.scale(zoom, zoom);
    c.translate(-W / 2 + (hashN(jolt) - 0.5) * X(30) * hit, -H / 2 + (hashN(jolt + 7) - 0.5) * X(30) * hit);
    const cut = marks.find(m => m > 0 && t >= m - CUT_LEN / 2 && t < m + CUT_LEN / 2);
    if (cut !== undefined && !fz) {
      TRANSITION[cutKind[marks.indexOf(cut)]].draw(K, (t - cut + CUT_LEN / 2) / CUT_LEN,
        () => frame(at(cut - 0.001), t), () => frame(at(cut), t), { center: [W / 2, H * 0.45] });
    } else frame(index, fz ? fz.at : t);
    if (fz) freezeStamp(t - fz.at, fz);
    confetti(t, 0.28, 70, 1);
    if (cues.freeze) confetti(t, cues.freeze.at, 80, 2);
    confetti(t, END + 0.05, 120, 3);
    // PlaceReel's focus lines, beat sparks, streaks, glitch, HUD and cut smears.
    overdrive(K, t, marks);
    c.restore();
    if (hit > 0.45) K.fill(`rgba(255,255,255,${Math.min(0.55, (hit - 0.45) * 0.8)})`);
    chrome(t);
  };

  // Word pops of every heading, so the score can hit them.
  const pops = [];
  plan.scenes.forEach((s, i) => {
    const units = new Set(headLay(i).glyphs.map(g => g.i0)).size;
    for (let k = 0; k < units; k++) pops.push(s.start + 0.08 + k * 0.045);
  });
  return { draw, pops };
}

function soundEvents(plan, speech, cues, headingPops, duration, roll) {
  const END = duration - 2, ROLL = END - ROLL_LEN;
  const pops = [...headingPops], ticks = [], stickers = [], swaps = [];
  speech.forEach(s => { for (let t = s.start; t < s.start + s.dur; t += BEAT / 2) pops.push(t); });
  for (let t = 0.35; t < 1.2; t += BEAT / 4) ticks.push(t);                    // hook counters
  (plan.stars ?? []).slice(0, 7).forEach((_, k) => pops.push(0.55 + k * 0.06)); // avatars fly in
  (plan.stars ?? []).slice(0, 8).forEach((_, k) => pops.push(END + 0.08 + k * 0.05));
  cues.scenes.forEach(sc => {
    sc.cards.forEach(card => { swaps.push(card.at); ticks.push(...card.chips); });
    sc.stickers.forEach(st => stickers.push(st.at));
  });
  plan.scenes.forEach(s => stickers.push(s.start + 0.05)); // giant emoji smash
  roll.slice(0, ROLL_SHOWN).forEach((_, k) => swaps.push(ROLL + rollAt(k)));
  const zaps = [];
  for (let t = BEAT; t < END; t += BEAT * 2) zaps.push(t);
  return {
    pops, ticks, stickers, swaps, zaps, voiced: true,
    cuts: [...plan.scenes.slice(1).map(s => s.start), ...(roll.length ? [ROLL] : [])],
    booms: plan.scenes.map(s => s.start),
    hits: [{ t: 0, amp: 0.7 }, { t: 2, amp: 0.6 }, ...(cues.freeze ? [{ t: cues.freeze.at, amp: 0.8 }] : []), { t: END, amp: 1 }],
    scratch: [0], freeze: cues.freeze ? [cues.freeze.at] : [], swells: [[END - 1, END]],
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

// `options.styles` / `options.headings` pin the post / heading style of each scene (for previews); normally they are shuffled per day.
window.prepareVideo = async (plan, audio, avatars = {}, options = {}) => {
  await document.fonts.ready;
  const roll = rollCall(plan);
  const { speech, tooLong, duration } = await prepareAudio(plan, audio, roll.length ? ROLL_LEN : 0);
  if (tooLong.length) return { tooLong };
  // PlaceReel's clock accepts listed lengths only; any even length up to 60 s works with its grid.
  if (!LENGTHS.includes(duration)) LENGTHS.push(duration);
  setDuration(duration);
  const faces = {};
  for (const [id, url] of Object.entries(avatars)) {
    try { faces[id] = await createImageBitmap(await (await fetch(url)).blob()); } catch { /* initials */ }
  }
  const cues = cueSheet(plan);
  const renderer = makeRenderer(plan, speech, faces, cues, duration, roll, options);
  render = renderer.draw;
  const soundtrack = await renderSoundtrack({ seed: Number(plan.date.replaceAll('-', '')) }, plan.music,
    { energy: ENERGY.dopamine, events: soundEvents(plan, speech, cues, renderer.pops, duration, roll), speech });
  const response = await fetch('/soundtrack', { method: 'POST', body: wav(soundtrack) });
  if (!response.ok) throw new Error('Could not save soundtrack');
  return { tooLong: [], duration, scenes: plan.scenes.map((s) => [s.start, s.end]) };
};
window.renderFrame = t => { render(t); return canvas.toDataURL('image/jpeg', .9).split(',')[1]; };
window.postStyleIds = () => Object.keys(createPostStyles({ K: {}, X: (v) => v, plan: {}, posts: [], seed: 0 }).STYLES);
window.headingStyleIds = () => Object.keys(createHeadingStyles({ K: {}, X: (v) => v, seed: 0 }).STYLES);
