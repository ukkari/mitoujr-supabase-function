// Shared toolkit for every effect: math, easing, text layout, shapes, photos, map,
// typography themes. Effects receive one `K` object and always read `K.ctx` fresh
// (transitions swap it to render scenes into offscreen snapshots).

import { project, tilesFor, tileLevel } from './assets.js';
import { HITS } from './timeline.js';

// ---------------------------------------------------------------- math
export const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const seg = (t, a, b) => clamp((t - a) / (b - a));
export const TAU = Math.PI * 2;
export const E = {
  linear: (t) => t,
  outCubic: (t) => 1 - (1 - t) ** 3,
  inCubic: (t) => t ** 3,
  inOutCubic: (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2),
  outQuint: (t) => 1 - (1 - t) ** 5,
  inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  outExpo: (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
  inExpo: (t) => (t <= 0 ? 0 : 2 ** (10 * t - 10)),
  inOutExpo: (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2),
  outBack: (t, s = 1.70158) => 1 + (s + 1) * (t - 1) ** 3 + s * (t - 1) ** 2,
  outElastic: (t) => (t <= 0 ? 0 : t >= 1 ? 1 : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * (TAU / 3)) + 1),
  outBounce: (t) => {
    const n = 7.5625, d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
    return n * (t -= 2.625 / d) * t + 0.984375;
  },
};

export function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const hashN = (n) => mulberry32(Math.floor(n) * 2654435761)();

// ---------------------------------------------------------------- text
export const CJK = /[぀-ヿ㐀-鿿가-힯＀-￯　-〿]/;
const NO_START = /^[、。，．・：；？！!?）」』】ー〜…,.):;]/;
export const HIGHLIGHT = /\b(best|amazing|incredible|perfect|unforgettable|stunning|delicious|fantastic|outstanding|exceptional|wonderful|breathtaking|spectacular|gem|superb|flawless|heavenly|magical|divine|must[- ]visit|to die for|world[- ]class|beautiful|love[ds]?)\b/i;
const SEGMENTER = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('ja', { granularity: 'word' }) : null;

export function tokenize(text) {
  if (SEGMENTER && CJK.test(text)) return [...SEGMENTER.segment(text)].map((x) => x.segment);
  return text.match(/\S+|\s+/g) || [];
}

export function layoutText(ctx, text, maxW) {
  const lines = [];
  let cur = [], x = 0, ci = 0;
  const flush = () => { if (cur.length) { const l = cur[cur.length - 1]; lines.push({ units: cur, w: l.x + l.w }); } cur = []; x = 0; };
  const space = ctx.measureText(' ').width;
  for (const tk of tokenize(text)) {
    const i0 = ci; ci += tk.length;
    if (/^\s+$/.test(tk)) { if (cur.length) x += space; continue; }
    const w = ctx.measureText(tk).width;
    if (w > maxW && CJK.test(tk)) {
      let k = i0;
      for (const ch of tk) {
        const cw = ctx.measureText(ch).width;
        if (x + cw > maxW && cur.length && !NO_START.test(ch)) flush();
        cur.push({ s: ch, x, w: cw, i0: k, i1: k + ch.length });
        x += cw; k += ch.length;
      }
      continue;
    }
    if (x + w > maxW && cur.length && !NO_START.test(tk)) flush();
    cur.push({ s: tk, x, w, i0, i1: ci });
    x += w;
  }
  flush();
  return lines;
}

export function toGlyphs(ctx, lines) {
  const out = [];
  lines.forEach((line, li) => {
    for (const u of line.units) {
      if (u.s.length === 1) { out.push({ ...u, li }); continue; }
      let acc = '';
      for (const ch of u.s) {
        const x = u.x + ctx.measureText(acc).width;
        acc += ch;
        out.push({ s: ch, x, w: ctx.measureText(ch).width, li, i0: u.i0, i1: u.i1 });
      }
    }
  });
  return out;
}

export function ellipsize(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  const chars = [...text];
  while (chars.length && ctx.measureText(chars.join('') + '…').width > maxW) chars.pop();
  return chars.join('') + '…';
}

// ---------------------------------------------------------------- shapes
export function starPath(ctx, cx, cy, r, inner = 0.48) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * inner : r;
    ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  ctx.closePath();
}

export function pinPath(ctx, x, y, s) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.bezierCurveTo(x - s * 0.18, y - s * 0.45, x - s * 0.55, y - s * 0.62, x - s * 0.55, y - s * 1.0);
  ctx.arc(x, y - s * 1.0, s * 0.55, Math.PI, 0);
  ctx.bezierCurveTo(x + s * 0.55, y - s * 0.62, x + s * 0.18, y - s * 0.45, x, y);
  ctx.closePath();
}

// organic blob (ink, burns): radius wobbles with seeded harmonics
export function blobPath(ctx, cx, cy, r, seed = 1, wob = 0.18, t = 0) {
  ctx.beginPath();
  const n = 72;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * TAU;
    const k = 1 + wob * (Math.sin(a * 3 + seed + t) * 0.5 + Math.sin(a * 5 - seed * 2 + t * 1.3) * 0.3 + Math.sin(a * 9 + seed * 3) * 0.2);
    ctx.lineTo(cx + Math.cos(a) * r * k, cy + Math.sin(a) * r * k);
  }
  ctx.closePath();
}

export function cover(ctx, img, x, y, w, h, zoom = 1, ox = 0, oy = 0) {
  const iw = img.width, ih = img.height;
  const s = Math.max(w / iw, h / ih) * zoom;
  const dw = iw * s, dh = ih * s;
  ctx.drawImage(img, x + (w - dw) / 2 + (ox * (dw - w)) / 2, y + (h - dh) / 2 + (oy * (dh - h)) / 2, dw, dh);
}

// ---------------------------------------------------------------- type themes
const SANS_FB = '"Noto Sans JP", system-ui, sans-serif';
export const TYPE_THEMES = {
  modern: {
    display: { fam: `"Inter Tight", ${SANS_FB}`, w: 900, track: -0.01 },
    serif: { fam: '"Instrument Serif", Georgia, serif', w: 400, italic: true },
    body: { fam: `"Inter Tight", ${SANS_FB}`, w: 500 },
    mono: { fam: '"JetBrains Mono", ui-monospace, monospace', w: 700, track: 0.08, upper: true },
    hand: { fam: '"Caveat", cursive', w: 700 },
  },
  editorial: {
    display: { fam: `"Playfair Display", Georgia, serif`, w: 800, track: -0.01 },
    serif: { fam: '"Playfair Display", Georgia, serif', w: 400, italic: true },
    body: { fam: `"Inter Tight", ${SANS_FB}`, w: 500 },
    mono: { fam: '"JetBrains Mono", ui-monospace, monospace', w: 500, track: 0.14, upper: true },
    hand: { fam: '"Caveat", cursive', w: 700 },
  },
  luxury: {
    display: { fam: `"Bodoni Moda", Georgia, serif`, w: 500, track: 0.08, upper: true },
    serif: { fam: '"Bodoni Moda", Georgia, serif', w: 400, italic: true },
    body: { fam: `"Inter Tight", ${SANS_FB}`, w: 400, track: 0.02 },
    mono: { fam: '"Inter Tight", sans-serif', w: 500, track: 0.3, upper: true },
    hand: { fam: '"Bodoni Moda", Georgia, serif', w: 400, italic: true },
  },
  condensed: {
    display: { fam: `"Anton", "Inter Tight", ${SANS_FB}`, w: 400, track: 0.01, upper: true },
    serif: { fam: '"Instrument Serif", Georgia, serif', w: 400, italic: true },
    body: { fam: `"Inter Tight", ${SANS_FB}`, w: 600 },
    mono: { fam: '"JetBrains Mono", ui-monospace, monospace', w: 700, track: 0.1, upper: true },
    hand: { fam: '"Caveat", cursive', w: 700 },
  },
  playful: {
    display: { fam: `"Fredoka", ${SANS_FB}`, w: 700, track: 0 },
    serif: { fam: '"Caveat", cursive', w: 700 },
    body: { fam: `"Fredoka", ${SANS_FB}`, w: 500 },
    mono: { fam: '"Fredoka", sans-serif', w: 600, track: 0.12, upper: true },
    hand: { fam: '"Caveat", cursive', w: 700 },
  },
  tech: {
    display: { fam: `"Space Grotesk", ${SANS_FB}`, w: 700, track: -0.02 },
    serif: { fam: '"Space Grotesk", sans-serif', w: 400 },
    body: { fam: `"Space Grotesk", ${SANS_FB}`, w: 500 },
    mono: { fam: '"JetBrains Mono", ui-monospace, monospace', w: 500, track: 0.12, upper: true },
    hand: { fam: '"JetBrains Mono", monospace', w: 500 },
  },
  retro: {
    display: { fam: `"Bungee", "Inter Tight", ${SANS_FB}`, w: 400, track: 0, upper: true },
    serif: { fam: '"Instrument Serif", Georgia, serif', w: 400, italic: true },
    body: { fam: `"Inter Tight", ${SANS_FB}`, w: 600 },
    mono: { fam: '"JetBrains Mono", ui-monospace, monospace', w: 700, track: 0.1, upper: true },
    hand: { fam: '"Caveat", cursive', w: 700 },
  },
};

// every font the themes can request (for preloading)
export const FONT_SPECS = [
  '900 80px "Inter Tight"', '800 80px "Inter Tight"', '700 80px "Inter Tight"', '600 80px "Inter Tight"', '500 80px "Inter Tight"', '400 80px "Inter Tight"',
  'italic 400 80px "Instrument Serif"', '400 80px "Instrument Serif"',
  '500 40px "JetBrains Mono"', '700 40px "JetBrains Mono"',
  '800 80px "Playfair Display"', '400 80px "Playfair Display"', 'italic 400 80px "Playfair Display"',
  '500 80px "Bodoni Moda"', '400 80px "Bodoni Moda"', 'italic 400 80px "Bodoni Moda"',
  '400 80px "Anton"', '700 80px "Fredoka"', '600 80px "Fredoka"', '500 80px "Fredoka"',
  '700 80px "Space Grotesk"', '500 80px "Space Grotesk"', '400 80px "Space Grotesk"',
  '400 80px "Bungee"', '700 80px "Caveat"', '900 80px "Noto Sans JP"', '700 80px "Noto Sans JP"',
];

// ================================================================ kit factory
export function createKit(canvas, model, assets, direction) {
  const W = canvas.width, H = canvas.height;
  const P = H > W;
  const u = Math.min(W, H) / 1080;
  const pal = assets.palette;
  const place = model.place;
  const theme = TYPE_THEMES[direction.type] || TYPE_THEMES.modern;
  const R = mulberry32((model.seed ^ ((direction.variant || 0) * 0x9e3779b1)) >>> 0);
  const MAP_K = 1.4 * u;

  const K = {
    ctx: canvas.getContext('2d', { alpha: false }),
    main: null, W, H, P, u, pal, model, place, dir: direction, R, theme,
    E, clamp, lerp, seg, TAU, hashN, cover, starPath, pinPath, blobPath, ellipsize,
    score: place.score ?? (model.hist.reduce((s, n, i) => s + n * (i + 1), 0) / Math.max(1, model.sample)),
    fmt: (n) => Math.round(n).toLocaleString('en-US'),
  };
  K.main = K.ctx;

  // ---------- fonts
  K.font = (role, size, opts = {}) => {
    const r = theme[role] || theme.body;
    const w = opts.w ?? r.w;
    const italic = (opts.italic ?? r.italic) ? 'italic ' : '';
    const f = `${italic}${w} ${Math.round(size)}px ${r.fam}`;
    K.ctx.font = f;
    K.ctx.letterSpacing = `${((opts.track ?? r.track ?? 0) * size).toFixed(2)}px`;
    return f;
  };
  K.caps = (role, s) => ((theme[role] || {}).upper ? String(s).toUpperCase() : String(s));
  K.text = (role, size, s, x, y, opts = {}) => {
    K.font(role, size, opts);
    const c = K.ctx;
    c.fillStyle = opts.color || '#fff';
    c.textAlign = opts.align || 'left';
    c.textBaseline = opts.baseline || 'alphabetic';
    const str = K.caps(role, s);
    const out = opts.maxW ? ellipsize(c, str, opts.maxW) : str;
    c.fillText(out, x, y);
    const w = c.measureText(out).width;
    c.textAlign = 'left';
    c.letterSpacing = '0px';
    return w;
  };

  // Fit text to a box, cached. Returns { size, lines, glyphs, lineH, str }
  const fitCache = new Map();
  K.fit = (key, text, role, maxW, maxLines, maxSize, minSize, opts = {}) => {
    const ck = `${key}|${maxW}|${maxLines}|${maxSize}|${role}|${opts.w}`;
    if (fitCache.has(ck)) return fitCache.get(ck);
    const str = K.caps(role, text);
    let size = maxSize, lines;
    for (;;) {
      K.font(role, size, opts);
      lines = layoutText(K.ctx, str, maxW);
      if ((lines.length <= maxLines && lines.every((l) => l.w <= maxW * 1.02)) || size <= minSize) break;
      size = Math.max(minSize, size * 0.93);
    }
    K.font(role, size, opts);
    const res = { size, lines, glyphs: toGlyphs(K.ctx, lines), str, role, opts, lineH: size * (opts.lh ?? (CJK.test(str) ? 1.15 : role === 'display' ? 1.0 : 1.2)) };
    K.ctx.letterSpacing = '0px';
    fitCache.set(ck, res);
    return res;
  };
  K.lineX = (lay, li, x0, maxW, align) => (align === 'center' ? x0 + (maxW - lay.lines[li].w) / 2 : align === 'right' ? x0 + maxW - lay.lines[li].w : x0);

  // Per-glyph reveals. mode: rise | fade | drop | scale | type | blur
  K.reveal = (lay, x0, yTop, t0, tau, o = {}) => {
    const c = K.ctx;
    const { mode = 'rise', color = '#fff', stagger = 0.03, dur = 0.8, align = 'left', maxW = 0, shadow = false, stroke = null } = o;
    K.font(lay.role, lay.size, lay.opts);
    c.textBaseline = 'alphabetic';
    const st = Math.min(stagger, 0.75 / Math.max(1, lay.glyphs.length));
    lay.glyphs.forEach((g, i) => {
      const a = t0 + i * st;
      const raw = seg(tau, a, a + dur);
      if (raw <= 0) return;
      const p = mode === 'drop' ? E.outBounce(raw) : mode === 'scale' ? E.outBack(raw, 2.2) : E.outExpo(raw);
      const x = K.lineX(lay, g.li, x0, maxW, align) + g.x;
      const base = yTop + g.li * lay.lineH + lay.size * 0.86;
      c.save();
      if (shadow) { c.shadowColor = 'rgba(0,0,0,.4)'; c.shadowBlur = 30 * u; }
      c.fillStyle = color;
      if (mode === 'rise') {
        c.beginPath();
        c.rect(x - lay.size * 0.3, base - lay.size * 1.1, g.w + lay.size * 0.6, lay.size * 1.42);
        c.clip();
        c.fillText(g.s, x, base + (1 - p) * lay.size * 1.1);
      } else if (mode === 'fade') {
        c.globalAlpha *= p;
        c.fillText(g.s, x, base + (1 - p) * lay.size * 0.25);
      } else if (mode === 'drop') {
        c.globalAlpha *= clamp(raw * 4);
        c.fillText(g.s, x, base - (1 - p) * lay.size * 2.2);
      } else if (mode === 'scale') {
        c.globalAlpha *= clamp(raw * 3);
        c.translate(x + g.w / 2, base - lay.size * 0.35);
        c.scale(p, p);
        c.fillText(g.s, -g.w / 2, lay.size * 0.35);
      } else if (mode === 'type') {
        if (raw > 0) c.fillText(g.s, x, base);
      } else if (mode === 'blur') {
        c.globalAlpha *= p;
        c.filter = `blur(${((1 - p) * 18 * u).toFixed(1)}px)`;
        c.fillText(g.s, x, base);
      }
      if (stroke && p > 0) { c.strokeStyle = stroke; c.lineWidth = 2 * u; c.strokeText(g.s, x, base); }
      c.restore();
    });
    c.letterSpacing = '0px';
    return lay.lines.length * lay.lineH;
  };

  // word-level reveal (quotes), with highlight marker support.
  // With energy.wordPop the words land on the 16th-note grid and pop in (the score has a pop on each).
  K.revealWords = (lay, x0, yTop, t0, tau, o = {}) => {
    const c = K.ctx;
    const { color = '#fff', align = 'left', maxW = 0, hl = null, hlColor = pal.accent, mode = 'rise', stagger = 0.05 } = o;
    const pop = (K.energy?.wordPop || K.popTiming || o.popStep) && mode !== 'type';
    K.font(lay.role, lay.size, lay.opts);
    c.textBaseline = 'alphabetic';
    const units = lay.lines.flatMap((l, li) => l.units.map((un) => ({ ...un, li })));
    // with a voiceover the words follow the read (K.popTiming / o.popStep), else the 16th grid
    const st = pop ? (o.popStep || K.popTiming?.step || K.WORD_STEP) : Math.min(stagger, 0.55 / Math.max(1, units.length));
    const start = pop ? (o.popStart ?? K.popTiming?.start ?? K.WORD_START) : t0;
    const revealEnd = start + units.length * st + (pop ? 0.05 : 0.3);
    const light = /^#f|^#e|^#d|^white|255,\s*255,\s*255/i.test(color);
    units.forEach((un, i) => {
      const a = start + i * st;
      const raw = seg(tau, a, a + (pop ? 0.16 : 0.7));
      const pr = pop ? E.outBack(raw, 2.8) : E.outExpo(raw);
      if (raw <= 0) return;
      const bx = K.lineX(lay, un.li, x0, maxW, align) + un.x;
      const by = yTop + un.li * lay.lineH + lay.size;
      const isHl = hl && un.i1 > hl[0] && un.i0 < hl[1];
      if (isHl && !(pop && light)) {
        const hp = pop ? E.outExpo(seg(tau, a, a + 0.12)) : E.outExpo(seg(tau, revealEnd, revealEnd + 0.4));
        if (hp > 0) {
          c.fillStyle = pop ? '#ffd400' : hlColor;
          c.globalAlpha = 0.9;
          c.fillRect(bx - 3 * u, by - lay.size * 0.27, (un.w + 6 * u) * hp, lay.size * 0.32);
        }
      }
      c.save();
      if (pop) {
        c.translate(bx + un.w / 2, by - lay.size * 0.35);
        const s = pr * (isHl ? 1 + 0.12 * Math.exp(-Math.max(0, tau - a) * 6) : 1);
        c.scale(s, s);
        c.translate(-(bx + un.w / 2), -(by - lay.size * 0.35));
        c.globalAlpha = clamp(raw * 3);
        if (isHl && light) {
          c.lineJoin = 'round'; c.strokeStyle = '#000'; c.lineWidth = lay.size * 0.14;
          c.strokeText(un.s, bx, by);
          c.fillStyle = '#ffd400';
        } else c.fillStyle = color;
        c.fillText(un.s, bx, by);
      } else {
        c.globalAlpha = mode === 'type' ? 1 : pr;
        c.fillStyle = color;
        c.fillText(un.s, bx, by + (mode === 'rise' ? (1 - pr) * 36 * u : 0));
      }
      c.restore();
    });
    c.globalAlpha = 1;
    c.letterSpacing = '0px';
    return lay.lines.length * lay.lineH;
  };

  // ---------- photos
  const pool = [...assets.photos]
    .map((p) => {
      const s = p.stats;
      const fit = P ? (s.aspect < 0.95 ? 0.5 : 0) : (s.aspect > 1.15 ? 0.5 : 0);
      return { p, score: s.sat * 1.3 + s.contrast * 1.1 + (1 - Math.abs(s.val - 0.55)) * 0.8 + (p.from === 'place' ? 0.7 : 0) + fit };
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.p);
  K.pool = pool;
  K.hero = pool[(direction.variant || 0) % Math.min(3, pool.length)];
  const used = new Set([K.hero]);
  K.take = () => {
    const fresh = pool.find((p) => !used.has(p));
    const p = fresh || pool[Math.floor(R() * pool.length)];
    used.add(p);
    return p;
  };
  K.claim = (p) => { if (p) used.add(p); return p; };
  K.isUsed = (p) => used.has(p);

  // ---------- map
  K.drawMap = (z, cx, cy, halfW, halfH, bias = 0, grade = 'accent') => {
    const c = K.ctx;
    const L = tileLevel(z, MAP_K, bias);
    const s = MAP_K * 2 ** (z - L);
    const [X, Y] = project(place.lat, place.lng, L);
    const n = 2 ** L;
    const size = 256 * s;
    const x0 = Math.floor((X - halfW / s) / 256), x1 = Math.floor((X + halfW / s) / 256);
    const y0 = Math.max(0, Math.floor((Y - halfH / s) / 256)), y1 = Math.min(n - 1, Math.floor((Y + halfH / s) / 256));
    c.fillStyle = '#0c0c0e';
    c.fillRect(cx - halfW, cy - halfH, halfW * 2, halfH * 2);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const wx = ((tx % n) + n) % n;
        const dx = cx + (tx * 256 - X) * s, dy = cy + (ty * 256 - Y) * s;
        const img = assets.tiles.get(`${L}/${wx}/${ty}`);
        if (img) { c.drawImage(img, dx, dy, size + 0.8, size + 0.8); continue; }
        for (let up = 1; up <= 5; up++) {
          const pz = L - up, px = wx >> up, py = ty >> up;
          const pimg = assets.tiles.get(`${pz}/${px}/${py}`);
          if (!pimg) continue;
          const sub = pimg.width / 2 ** up;
          c.drawImage(pimg, (wx - (px << up)) * sub, (ty - (py << up)) * sub, sub, sub, dx, dy, size + 0.8, size + 0.8);
          break;
        }
      }
    }
    const rx = cx - halfW, ry = cy - halfH, rw = halfW * 2, rh = halfH * 2;
    c.save();
    if (grade === 'accent') {
      c.globalCompositeOperation = 'saturation'; c.fillStyle = 'hsl(0,0%,50%)'; c.globalAlpha = 0.45; c.fillRect(rx, ry, rw, rh);
      c.globalCompositeOperation = 'soft-light'; c.fillStyle = pal.accent; c.globalAlpha = 0.6; c.fillRect(rx, ry, rw, rh);
      c.globalCompositeOperation = 'multiply'; c.fillStyle = pal.hsl(pal.hue, 40, 45); c.globalAlpha = 0.35; c.fillRect(rx, ry, rw, rh);
    } else if (grade === 'mono') {
      c.globalCompositeOperation = 'saturation'; c.fillStyle = 'hsl(0,0%,50%)'; c.fillRect(rx, ry, rw, rh);
      c.globalCompositeOperation = 'multiply'; c.fillStyle = pal.hsl(pal.hue, 60, 35); c.globalAlpha = 0.8; c.fillRect(rx, ry, rw, rh);
    } else if (grade === 'blue') {
      c.globalCompositeOperation = 'saturation'; c.fillStyle = 'hsl(0,0%,50%)'; c.fillRect(rx, ry, rw, rh);
      c.globalCompositeOperation = 'multiply'; c.fillStyle = '#1d4f9c'; c.fillRect(rx, ry, rw, rh);
      c.globalCompositeOperation = 'screen'; c.fillStyle = 'rgba(40,110,220,.25)'; c.fillRect(rx, ry, rw, rh);
    }
    c.restore();
  };
  K.mapK = MAP_K;

  K.drawPin = (x, y, s, alpha = 1, color = pal.accent) => {
    const c = K.ctx;
    c.save();
    c.globalAlpha *= alpha;
    c.shadowColor = 'rgba(0,0,0,.5)'; c.shadowBlur = 24 * u; c.shadowOffsetY = 8 * u;
    pinPath(c, x, y, s);
    c.fillStyle = color; c.fill();
    c.shadowColor = 'transparent';
    c.beginPath(); c.arc(x, y - s, s * 0.22, 0, TAU);
    c.fillStyle = pal.ink; c.fill();
    c.restore();
  };

  // ---------- UI atoms
  K.stars = (cx, cy, r, gap, value, appear = () => ({ scale: 1, fill: 1 }), on = pal.accent, off = 'rgba(255,255,255,.18)') => {
    const c = K.ctx;
    for (let i = 0; i < 5; i++) {
      const a = appear(i);
      if (a.scale <= 0.001) continue;
      c.save();
      c.translate(cx + (i - 2) * gap, cy);
      c.scale(a.scale, a.scale);
      starPath(c, 0, 0, r); c.fillStyle = off; c.fill();
      const fill = clamp(value - i) * (a.fill ?? 1);
      if (fill > 0) {
        c.save(); c.beginPath(); c.rect(-r, -r, 2 * r * fill, 2 * r); c.clip();
        starPath(c, 0, 0, r); c.fillStyle = on; c.fill(); c.restore();
      }
      c.restore();
    }
  };

  K.pill = (x, y, text, { role = 'body', size = 22, w: weight, h, padX, bg, fg = '#fff', stroke, alpha = 1, scaleX = 1, align = 'left' } = {}) => {
    const c = K.ctx;
    c.save();
    K.font(role, size * u, { w: weight });
    const str = K.caps(role, text);
    const hh = (h ?? size * 2.1) * u, px = (padX ?? size * 0.95) * u;
    const w = c.measureText(str).width + px * 2;
    const x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    c.globalAlpha *= alpha;
    c.beginPath();
    c.roundRect(x0, y, w * scaleX, hh, hh / 2);
    if (bg) { c.fillStyle = bg; c.fill(); }
    if (stroke) { c.strokeStyle = stroke; c.lineWidth = 2 * u; c.stroke(); }
    c.clip();
    c.fillStyle = fg;
    c.textBaseline = 'middle';
    c.fillText(str, x0 + px, y + hh / 2 + 1 * u);
    c.restore();
    K.ctx.letterSpacing = '0px';
    return w;
  };

  K.avatar = (img, x, y, r, name) => {
    const c = K.ctx;
    c.save();
    c.beginPath(); c.arc(x, y, r, 0, TAU); c.clip();
    if (img) cover(c, img, x - r, y - r, 2 * r, 2 * r);
    else {
      c.fillStyle = pal.accentDeep; c.fillRect(x - r, y - r, 2 * r, 2 * r);
      K.text('display', r, [...(name || '?')][0].toUpperCase(), x, y + r * 0.05, { align: 'center', baseline: 'middle' });
    }
    c.restore();
    c.beginPath(); c.arc(x, y, r + 3 * u, 0, TAU);
    c.strokeStyle = pal.accent; c.lineWidth = 2.5 * u; c.stroke();
  };

  K.gradient = (stops, x0, y0, x1, y1) => {
    const g = K.ctx.createLinearGradient(x0, y0, x1, y1);
    stops.forEach(([o, col]) => g.addColorStop(o, col));
    return g;
  };
  K.radial = (x, y, r, inner, outer = 'transparent') => {
    const g = K.ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, inner); g.addColorStop(1, outer);
    return g;
  };
  K.fill = (style, x = 0, y = 0, w = W, h = H) => { K.ctx.fillStyle = style; K.ctx.fillRect(x, y, w, h); };
  K.darken = (a) => K.fill(`rgba(0,0,0,${a})`);
  K.vignetteBottom = (a = 0.85, from = 0.3) => K.fill(K.gradient([[0, `rgba(0,0,0,${a})`], [0.55, `rgba(0,0,0,${a * 0.4})`], [1, 'rgba(0,0,0,0)']], 0, H, 0, H * from));

  // Hit envelope for flashes/shakes/particles
  K.hit = (t) => {
    let a = 0;
    for (const h of K.hits || HITS) if (t >= h.t) a += h.amp * Math.exp(-(t - h.t) * 9);
    return a;
  };

  // ---------- offscreen snapshots (transitions)
  const snaps = [];
  let depth = 0;
  K.snap = (i, draw) => {
    const key = i + depth * 4; // nested transitions get their own canvases
    if (!snaps[key]) snaps[key] = new OffscreenCanvas(W, H);
    const off = snaps[key];
    const prev = K.ctx;
    K.ctx = off.getContext('2d');
    K.ctx.setTransform(1, 0, 0, 1, 0, 0);
    K.ctx.globalAlpha = 1;
    K.ctx.globalCompositeOperation = 'source-over';
    K.ctx.filter = 'none';
    K.ctx.fillStyle = '#000';
    K.ctx.fillRect(0, 0, W, H);
    depth++;
    try { draw(); } finally { depth--; K.ctx = prev; }
    return off;
  };
  // small scratch canvas (pixelate, halftone…)
  const scratch = new Map();
  K.scratch = (key, w, h) => {
    let s = scratch.get(key);
    if (!s || s.width !== w || s.height !== h) { s = new OffscreenCanvas(Math.max(1, w), Math.max(1, h)); scratch.set(key, s); }
    return s;
  };

  // lazily built RGB-split copies of any image (glitch)
  const splitCache = new Map();
  K.channels = (img) => {
    if (splitCache.has(img)) return splitCache.get(img);
    const out = ['#ff0000', '#00ff00', '#0000ff'].map((col) => {
      const c = new OffscreenCanvas(Math.min(1280, img.width), Math.round((Math.min(1280, img.width) * img.height) / img.width));
      const x = c.getContext('2d');
      x.drawImage(img, 0, 0, c.width, c.height);
      x.globalCompositeOperation = 'multiply';
      x.fillStyle = col; x.fillRect(0, 0, c.width, c.height);
      return c;
    });
    splitCache.set(img, out);
    return out;
  };

  return K;
}

// Shared camera for satellite zooms (planTiles + drawing must agree).
export function zoomPath(t, from = 2.2, to = 16.2, a = 0.25, b = 2.55) {
  const p = E.inOutCubic(seg(t, a, b));
  let z = lerp(from, to, p);
  if (t > b) z = to + 0.7 * E.outCubic(seg(t, b, 4.2));
  // fast middle of the dive → coarser tiles (motion hides it, saves ~75% of downloads)
  const speed = Math.abs((to - from) * (E.inOutCubic(seg(t + 0.02, a, b)) - E.inOutCubic(seg(t - 0.02, a, b))) / 0.04);
  return { z, p, bias: speed > 6 ? 1 : 0 };
}

export { tilesFor };
