// How a topic scene shows its original posts. Every scene gets one of these looks (a different one
// per scene, shuffled per day), each with its own entrance. Boxes are sized from their text: short
// posts take little room and the type grows until the scene's area is full; when even the smallest
// type cannot fit, the boxes pile up and overflow instead of being cut.
import { E, clamp, lerp, seg, TAU, hashN, ellipsize } from './vendor/placereel/kit.js';
import { kickEnv } from './vendor/placereel/energy.js';

const GRAPHEMES = new Intl.Segmenter('ja', { granularity: 'grapheme' });
const graphemes = (s) => [...GRAPHEMES.segment(s)].map((x) => x.segment);
const reactionsOf = (p) => p.reactions.reduce((n, r) => n + r.count, 0);
const FLAP_POOL = [...'アイウエオカキクケコサシスセソタチツテトナニヌネノ0123456789ABCDEF#@!?'];

export function createPostStyles({ K, X, W, H, plan, posts, seed, col, rr, face, emo }) {
  const cache = new Map();

  // ---------- layout
  const lay = (text, w, fs, o = {}) => K.fit(`post|${text}|${o.lh ?? 1.25}`, text, 'body', w, 99, fs, fs, { w: o.w ?? 800, lh: o.lh ?? 1.25 });
  const tH = (l) => l.lines.length * l.lineH;
  const lW = (l) => Math.max(0, ...l.lines.map((x) => x.w));
  // Largest type size (stepping down) whose layout fits `avail`; cached per scene.
  function fit(key, max, min, build, avail, finish = (r) => r) {
    if (cache.has(key)) return cache.get(key);
    let r;
    for (let fs = max; ; fs = Math.max(min, fs - X(2))) {
      r = build(fs);
      if (r.total <= avail || fs <= min) break;
    }
    r.fits = r.total <= avail;
    const out = finish(r);
    cache.set(key, out);
    return out;
  }
  // Vertical stack of content-sized boxes; overlaps (a pile) when it cannot fit.
  function stack(S, name, { max, min, gap, measure, avail = S.A.h, align = 'center', top = S.A.y }) {
    return fit(`${name}${S.i}`, max, min, (fs) => {
      const ms = S.items.map((it) => measure(it, fs));
      const sum = ms.reduce((s, m) => s + m.h, 0);
      return { fs, ms, sum, total: sum + gap * Math.max(0, ms.length - 1) };
    }, avail, (r) => {
      const n = r.ms.length, g = r.fits ? gap : n > 1 ? (avail - r.sum) / (n - 1) : 0;
      let y = top + (r.fits ? (align === 'center' ? (avail - r.total) / 2 : align === 'bottom' ? avail - r.total : 0) : 0);
      r.h = r.ms.map((m) => m.h);
      r.lay = r.ms.map((m) => m.lay);
      r.y = r.h.map((h) => { const v = y; y += h + g; return v; });
      return r;
    });
  }

  // ---------- drawing helpers
  function tf(cx, cy, o, fn) {
    const c = K.ctx;
    c.save();
    if (o.a !== undefined) c.globalAlpha *= clamp(o.a);
    c.translate(cx, cy); c.rotate(o.r || 0); c.scale(o.sx ?? o.s ?? 1, o.sy ?? o.s ?? 1); c.translate(-cx, -cy);
    fn();
    c.restore();
  }
  const typed = (l, since, delay = 0.05, rate = 0.012, cap = 0.35) =>
    Math.ceil(l.glyphs.length * seg(since, delay, delay + Math.min(cap, l.glyphs.length * rate)));
  function drawText(l, x, y, { color = '#111', upto = Infinity, align = 'left', maxW = 0, stroke = null, sw = 0.18 } = {}) {
    const c = K.ctx;
    K.font('body', l.size, l.opts);
    c.textBaseline = 'top'; c.lineJoin = 'round';
    const gs = upto >= l.glyphs.length ? null : l.glyphs.slice(0, upto);
    for (const pass of stroke ? ['stroke', 'fill'] : ['fill']) {
      if (pass === 'stroke') { c.strokeStyle = stroke; c.lineWidth = l.size * sw; } else c.fillStyle = color;
      const put = (s, px, py) => (pass === 'stroke' ? c.strokeText(s, px, py) : c.fillText(s, px, py));
      // Whole words when fully shown (fewer draws); glyph by glyph while typing.
      if (!gs) l.lines.forEach((line, li) => line.units.forEach((u) => put(u.s, K.lineX(l, li, x, maxW, align) + u.x, y + li * l.lineH)));
      else gs.forEach((g) => put(g.s, K.lineX(l, g.li, x, maxW, align) + g.x, y + g.li * l.lineH));
    }
  }
  // Per-glyph motion: fn(g, k) → null (hidden) or { dx, dy, r, s, a, color }.
  function drawGlyphs(l, x, y, fn, { color = '#fff', stroke = null, sw = 0.18, align = 'left', maxW = 0 } = {}) {
    const c = K.ctx, shown = [];
    l.glyphs.forEach((g, k) => { const f = fn(g, k); if (f) shown.push([g, f]); });
    K.font('body', l.size, l.opts);
    c.textBaseline = 'top'; c.lineJoin = 'round';
    for (const pass of stroke ? ['stroke', 'fill'] : ['fill']) {
      shown.forEach(([g, f]) => {
        const gx = K.lineX(l, g.li, x, maxW, align) + g.x, gy = y + g.li * l.lineH;
        c.save();
        c.globalAlpha *= clamp(f.a ?? 1);
        c.translate(gx + g.w / 2 + (f.dx || 0), gy + l.size / 2 + (f.dy || 0));
        c.rotate(f.r || 0); c.scale(f.s ?? 1, f.s ?? 1);
        if (pass === 'stroke') { c.strokeStyle = f.stroke ?? stroke; c.lineWidth = l.size * sw; c.strokeText(g.s, -g.w / 2, -l.size / 2); }
        else { c.fillStyle = f.color ?? color; c.fillText(g.s, -g.w / 2, -l.size / 2); }
        c.restore();
      });
    }
  }
  const where = (p, i) => (p.channel !== plan.scenes[i].source && plan.sources[p.channel] ? ` · #${plan.sources[p.channel].name}` : '');
  function byline(p, i, x, y, size, { color = '#111', sub = '#777', ring = col(i), maxW = X(900), avatar = true, time = true } = {}) {
    const r = size / 2;
    if (avatar) face(p.userId, p.user, x + r, y + r, r, ring);
    const nx = avatar ? x + size + X(14) : x;
    const nw = K.text('body', size * 0.52, `@${p.user}`, nx, y + r, { color, w: 900, baseline: 'middle', maxW: Math.max(X(60), maxW * 0.55) });
    const rest = maxW - (nx - x) - nw - X(12);
    if (time && rest > X(40)) K.text('body', size * 0.42, `${p.time}${where(p, i)}`, nx + nw + X(12), y + r, { color: sub, w: 700, baseline: 'middle', maxW: rest });
  }
  // Reaction / reply badges, popping on the cue sheet's ticks.
  function chips(p, card, t, x, y, { size = X(30), align = 'right' } = {}) {
    const c = K.ctx, list = [...p.reactions.map((r) => [r.emoji, r.count]), ...(p.replies ? [['💬', p.replies]] : [])];
    const h = size * 1.87;
    let cx = x;
    list.forEach(([emoji, count], k) => {
      K.font('body', size, { w: 900 });
      const cw = c.measureText(`${count}`).width + size * 3.1;
      if (align === 'right') cx -= cw;
      const a = card.chips[k] ?? card.at, e = E.outBack(seg(t, a, a + 0.16), 3.2);
      if (e > 0) {
        tf(cx + cw / 2, y + h / 2, { s: e, r: 0.06 * (k % 2 ? 1 : -1) }, () => {
          rr(cx, y, cw, h, h / 2); c.fillStyle = k === 0 ? '#ffe100' : '#fff'; c.fill();
          c.strokeStyle = '#000'; c.lineWidth = size * 0.13; c.stroke();
          emo(emoji, cx + size * 1.2, y + h / 2, size * 1.47 * (1 + 0.35 * Math.exp(-(t - a) * 6)));
          K.text('body', size, String(Math.max(1, Math.round(count * E.outCubic(seg(t, a, a + 0.35))))), cx + size * 2.2, y + h / 2 + size * 0.05,
            { color: '#000', baseline: 'middle', w: 900 });
        });
      }
      cx += align === 'right' ? -size * 0.33 : cw + size * 0.33;
    });
    return cx;
  }
  function shadowed(fn, blur = X(30), dy = X(12), color = 'rgba(0,0,0,.45)') {
    const c = K.ctx;
    c.save(); c.shadowColor = color; c.shadowBlur = blur; c.shadowOffsetY = dy; fn(); c.restore();
  }
  // Standard post box: byline, typed text, chips on the top edge. `m` is the stack result.
  function postBox(S, it, x, y, w, h, m, o = {}) {
    const c = K.ctx, since = S.t - it.card.at, pad = o.pad ?? X(26), bh = o.bh ?? X(60), r = o.radius ?? X(30), ix = o.bar ? X(10) : 0;
    if (o.bg) {
      if (o.shadow === false) { rr(x, y, w, h, r); c.fillStyle = o.bg; c.fill(); }
      else shadowed(() => { rr(x, y, w, h, r); c.fillStyle = o.bg; c.fill(); });
    }
    if (o.bar) { c.save(); rr(x, y, w, h, r); c.clip(); K.fill(o.bar, x, y, X(14), h); c.restore(); }
    const glow = o.glow === false ? 0 : Math.exp(-Math.max(0, since) * 3);
    if (o.border || glow > 0.02) {
      rr(x, y, w, h, r); c.strokeStyle = o.border ?? col(S.i, 62, clamp(glow)); c.lineWidth = o.borderW ?? X(8); c.stroke();
    }
    byline(it.p, S.i, x + pad + ix, y + pad, bh, { color: o.fg ?? '#111', sub: o.sub ?? '#777', ring: o.ring ?? col(S.i), maxW: w - 2 * pad - ix, avatar: o.avatar !== false });
    const l = m.lay[it.j];
    drawText(l, x + pad + ix, y + pad + bh + X(10), { color: o.fg ?? '#111', upto: o.typed === false ? Infinity : typed(l, since) });
    if (o.chips !== false) chips(it.p, it.card, S.t, x + w - X(18), y - X(28), { size: X(28) });
  }
  const boxMeasure = (w, { pad = X(26), bh = X(60), weight = 800, lh = 1.25, ix = 0 } = {}) => (it, fs) => {
    const l = lay(it.p.text, w - 2 * pad - ix, fs, { w: weight, lh });
    return { lay: l, h: 2 * pad + bh + X(10) + tH(l) };
  };
  const spot = (it, x, y, w, h) => ({ card: it.card, x, y, w, h });
  const rnd = (...k) => hashN(seed * 7 + k.reduce((s, v, j) => s + v * [131, 17, 7, 3][j % 4], 0));
  // Paper / board backdrop behind a scene's area.
  function sheet(S, fill, { enter = 'up', r = X(24), rot = -0.012 } = {}) {
    const c = K.ctx, A = S.A, q = E.outExpo(seg(S.t, S.start, S.start + 0.3));
    const x = A.x - X(26), y = A.y - X(22), w = A.w + X(52), h = A.h + X(44);
    const dx = enter === 'right' ? (1 - q) * W : 0, dy = enter === 'up' ? (1 - q) * (H - y) : 0;
    c.save();
    c.translate(dx, dy); c.translate(x + w / 2, y + h / 2); c.rotate(rot); c.translate(-(x + w / 2), -(y + h / 2));
    shadowed(() => { rr(x, y, w, h, r); c.fillStyle = fill; c.fill(); }, X(40), X(16));
    return { x, y, w, h, done: () => c.restore() };
  }

  // =============================================================== styles
  const STYLES = {
    // 1. White cards slammed in from alternating sides.
    slam(S) {
      const A = S.A, m = stack(S, 'slam', { max: X(70), min: X(28), gap: X(40), measure: boxMeasure(A.w, { ix: X(10) }) });
      return S.items.map((it, j) => {
        const h = m.h[j], y = m.y[j], since = S.t - it.card.at;
        if (since >= 0) {
          const e = E.outBack(seg(since, 0, 0.28), 1.6), dir = j % 2 ? 1 : -1, x = A.x + (1 - e) * dir * W;
          tf(x + A.w / 2, y + h / 2, { r: lerp(dir * 0.3, dir * 0.014, e), s: j === S.latest ? 1 + 0.025 * kickEnv(S.t, 12) : 1 },
            () => postBox(S, it, x, y, A.w, h, m, { bg: '#fff', bar: col(S.i) }));
        }
        return spot(it, A.x, y, A.w, h);
      });
    },

    // 2. Chat app: bubbles grow from their tail, older ones scroll up and off the top.
    chat(S) {
      const c = K.ctx, A = S.A, r = X(40), pad = X(24), nameH = X(40), gap = X(34), maxB = A.w - 2 * r - X(40);
      const users = [...new Set(S.items.map((it) => it.p.userId))];
      const m = fit(`chat${S.i}`, X(62), X(30), (fs) => {
        const ms = S.items.map((it) => { const l = lay(it.p.text, maxB - 2 * pad, fs, { w: 700 }); return { lay: l, h: nameH + 2 * pad + tH(l), bw: lW(l) + 2 * pad }; });
        return { ms, total: ms.reduce((s, x) => s + x.h, 0) + gap * (ms.length - 1) };
      }, A.h);
      let yy = A.y;
      const ys = m.ms.map((x) => { const v = yy; yy += x.h + gap; return v; });
      const bottom = A.y + A.h, shift = (k) => (k < 0 ? bottom - ys[0] : bottom - (ys[k] + m.ms[k].h));
      const L = S.items.reduce((mx, it, j) => (S.t >= it.card.at ? j : mx), -1);
      const off = L < 0 ? 0 : lerp(shift(L - 1), shift(L), E.outCubic(seg(S.t - S.items[L].card.at, 0, 0.22)));
      return S.items.map((it, j) => {
        const mm = m.ms[j], since = S.t - it.card.at, right = users.indexOf(it.p.userId) % 2 === 1;
        const y = ys[j] + off, by = y + nameH, bw = mm.bw, bh = mm.h - nameH;
        const bx = right ? A.x + A.w - 2 * r - X(20) - bw : A.x + 2 * r + X(20);
        if (since >= 0) {
          const e = E.outBack(seg(since, 0, 0.25), 2.2), fade = clamp((y + mm.h - (A.y - X(80))) / X(160));
          const tx = right ? bx + bw : bx;
          tf(tx, by, { s: e, a: fade }, () => {
            face(it.p.userId, it.p.user, right ? A.x + A.w - r : A.x + r, by + r, r, col(S.i + (right ? 2 : 0)));
            K.text('body', X(26), `@${it.p.user}  ${it.p.time}${where(it.p, S.i)}`, right ? bx + bw : bx, y + nameH / 2,
              { align: right ? 'right' : 'left', baseline: 'middle', color: 'rgba(255,255,255,.85)', w: 700, maxW: A.w - 2 * r - X(40) });
            c.beginPath();
            if (right) { c.moveTo(bx + bw - X(20), by); c.lineTo(bx + bw + X(18), by); c.lineTo(bx + bw - X(4), by + X(26)); }
            else { c.moveTo(bx + X(20), by); c.lineTo(bx - X(18), by); c.lineTo(bx + X(4), by + X(26)); }
            c.fillStyle = right ? col(S.i, 72) : '#fff'; c.fill();
            rr(bx, by, bw, bh, Math.min(X(36), bh / 2)); c.fill();
            drawText(mm.lay, bx + pad, by + pad, { color: '#111', upto: typed(mm.lay, since, 0.08) });
            chips(it.p, it.card, S.t, right ? bx + X(10) : bx + bw - X(10), by + bh - X(24), { size: X(24), align: right ? 'left' : 'right' });
          });
        }
        return spot(it, bx, by, bw, bh);
      });
    },

    // 3. Phone notifications dropping in from the top, pushing older ones down.
    notif(S) {
      const c = K.ctx, A = S.A, pad = X(26), th = X(44), gap = X(20), icon = X(92), tw = A.w - 2 * pad - icon - X(22);
      const m = stack(S, 'notif', { max: X(64), min: X(28), gap, measure: (it, fs) => {
        const l = lay(it.p.text, tw, fs, { w: 700 });
        return { lay: l, h: 2 * pad + Math.max(icon, th + X(8) + tH(l)) };
      } });
      const arrived = (k) => E.outCubic(seg(S.t - S.items[k].card.at, 0, 0.25));
      const top = A.y + Math.max(0, m.fits ? (A.h - m.total) / 2 : 0);
      return S.items.map((it, j) => {
        let y = top;
        for (let k = j + 1; k < S.items.length; k++) y += (m.h[k] + gap) * arrived(k);
        const since = S.t - it.card.at, h = m.h[j];
        if (since >= 0) {
          const e = E.outBack(seg(since, 0, 0.3), 1.3), yy = lerp(-h - X(80), y, e);
          tf(A.x + A.w / 2, yy + h / 2, { s: lerp(0.92, 1, e), a: since * 6 }, () => {
            shadowed(() => { rr(A.x, yy, A.w, h, X(44)); c.fillStyle = 'rgba(246,246,250,.95)'; c.fill(); });
            face(it.p.userId, it.p.user, A.x + pad + icon / 2, yy + pad + icon / 2, icon / 2, col(S.i + j));
            const tx = A.x + pad + icon + X(22);
            const nw = K.text('body', X(32), `@${it.p.user}`, tx, yy + pad + th / 2, { color: '#111', w: 900, baseline: 'middle', maxW: tw * 0.5 });
            K.text('body', X(26), `#${plan.sources[it.p.channel]?.name ?? ''}`, tx + nw + X(12), yy + pad + th / 2,
              { color: '#888', w: 700, baseline: 'middle', maxW: Math.max(X(40), tw - nw - X(120)) });
            K.text('body', X(26), it.p.time, A.x + A.w - pad, yy + pad + th / 2, { align: 'right', color: '#888', w: 700, baseline: 'middle' });
            drawText(m.lay[j], tx, yy + pad + th + X(8), { color: '#222', upto: typed(m.lay[j], since) });
          });
          chips(it.p, it.card, S.t, A.x + A.w - X(18), yy - X(22), { size: X(24) });
        }
        return spot(it, A.x, y, A.w, h);
      });
    },

    // 4. Sticky notes in two columns, pressed onto the screen.
    sticky(S) {
      const c = K.ctx, A = S.A, gap = X(26), pad = X(26), bh = X(46), one = S.items.length === 1;
      const cw = one ? A.w : (A.w - gap) / 2;
      const m = fit(`sticky${S.i}`, X(70), X(28), (fs) => {
        const cols = [0, 0], out = S.items.map((it) => {
          const l = lay(it.p.text, cw - 2 * pad, fs, { w: 800, lh: 1.22 }), h = 2 * pad + bh + X(10) + tH(l);
          const k = cols[0] <= cols[1] ? 0 : 1, y = cols[k];
          cols[k] += h + gap;
          return { lay: l, h, k, y };
        });
        return { out, total: Math.max(...cols) - gap };
      }, A.h);
      const y0 = A.y + Math.max(0, (A.h - m.total) / 2), NOTES = ['#fff275', '#ff9fd0', '#8ae6ff', '#b7ff8a', '#ffc56b'];
      return S.items.map((it, j) => {
        const o = m.out[j], x = A.x + o.k * (cw + gap), y = y0 + o.y, since = S.t - it.card.at;
        if (since >= 0) {
          const q = seg(since, 0, 0.22), s = lerp(1.8, 1, E.outBack(q, 1.3)), rot = (rnd(S.i, j, 1) - 0.5) * 0.1;
          tf(x + cw / 2, y + o.h / 2, { s, r: rot, a: q * 4 }, () => {
            shadowed(() => { c.fillStyle = NOTES[(j + S.i) % NOTES.length]; c.fillRect(x, y, cw, o.h); }, lerp(X(60), X(18), q), lerp(X(60), X(10), q));
            K.fill(K.gradient([[0, 'rgba(0,0,0,0)'], [1, 'rgba(0,0,0,.12)']], 0, y + o.h * 0.6, 0, y + o.h), x, y + o.h * 0.6, cw, o.h * 0.4);
            tf(x + cw / 2, y, { r: -0.05 }, () => K.fill('rgba(255,255,255,.55)', x + cw / 2 - X(70), y - X(18), X(140), X(40)));
            byline(it.p, S.i, x + pad, y + pad, bh, { color: '#222', sub: '#555', ring: '#222', maxW: cw - 2 * pad });
            drawText(o.lay, x + pad, y + pad + bh + X(10), { color: '#1a1a1a', upto: typed(o.lay, since) });
            chips(it.p, it.card, S.t, x + cw - X(10), y + o.h - X(24), { size: X(24) });
          });
        }
        return spot(it, x, y, cw, o.h);
      });
    },

    // 5. Kinetic type: every glyph flies in from a random spot and assembles the quote.
    kinetic(S) {
      const A = S.A, nh = X(56), m = stack(S, 'kinetic', { max: X(92), min: X(40), gap: X(30), measure: (it, fs) => {
        const l = lay(it.p.text, A.w, fs, { w: 900, lh: 1.16 });
        return { lay: l, h: nh + X(10) + tH(l) };
      } });
      return S.items.map((it, j) => {
        const y = m.y[j], since = S.t - it.card.at, l = m.lay[j];
        if (since >= 0) {
          const pw = K.pill(A.x, y, `@${it.p.user} ${it.p.time}`, { size: 26, w: 900, bg: col(S.i + j), fg: '#000', scaleX: E.outBack(seg(since, 0, 0.2), 2) });
          chips(it.p, it.card, S.t, A.x + pw + X(16), y + X(4), { size: X(25), align: 'left' });
          const st = Math.min(0.018, 0.3 / l.glyphs.length);
          drawGlyphs(l, A.x, y + nh + X(10), (g, k) => {
            const q = E.outCubic(seg(since, k * st, k * st + 0.3));
            if (q <= 0) return null;
            const a = rnd(S.i, j, k, 1) * TAU, d = X(500 + 700 * rnd(S.i, j, k, 2)) * (1 - q);
            return { dx: Math.cos(a) * d, dy: Math.sin(a) * d, r: (rnd(S.i, j, k, 3) - 0.5) * 5 * (1 - q), s: lerp(3.2, 1, q), a: q * 3 };
          }, { color: '#fff', stroke: '#000', sw: 0.22 });
        }
        return spot(it, A.x, y, A.w, m.h[j]);
      });
    },

    // 6. Niconico-style comments streaming across the screen; the newest is pinned on top.
    danmaku(S) {
      const c = K.ctx, A = S.A, pinH = X(230), laneTop = A.y + pinH, laneH = X(96);
      const lanes = Math.max(3, Math.floor((A.h - pinH) / laneH)), spots = [];
      S.items.forEach((it, j) => {
        for (let k = 0; ; k++) {
          const born = it.card.at + k * 0.62 + rnd(S.i, j, k, 9) * 0.2;
          if (born > S.end) break;
          const size = X(44 + 34 * rnd(S.i, j, k, 1)), speed = X(850 + 650 * rnd(S.i, j, k, 2));
          const lane = (j * 3 + k * 5 + Math.floor(rnd(S.i, j, k, 3) * lanes)) % lanes, y = laneTop + lane * laneH + (laneH - size) / 2;
          if (k === 0) spots.push(spot(it, W * 0.55, y, W * 0.35, size));
          if (S.t < born) continue;
          K.font('body', size, { w: 900 });
          const tw = c.measureText(it.p.text).width, x = W + X(20) - (S.t - born) * speed;
          if (x + size * 1.3 + tw < -X(20)) continue;
          face(it.p.userId, it.p.user, x + size / 2, y + size / 2, size / 2, col(S.i + j));
          c.textBaseline = 'top'; c.lineJoin = 'round';
          c.strokeStyle = '#000'; c.lineWidth = size * 0.2; c.strokeText(it.p.text, x + size * 1.3, y);
          c.fillStyle = k % 3 === 0 ? '#fff' : col(S.i + j + k, 78); c.fillText(it.p.text, x + size * 1.3, y);
        }
      });
      const L = S.items.reduce((mx, it, j) => (S.t >= it.card.at ? j : mx), -1);
      if (L >= 0) {
        const it = S.items[L], since = S.t - it.card.at, e = E.outBack(seg(since, 0, 0.2), 2.5);
        const l = K.fit(`pin|${it.p.text}`, it.p.text, 'body', A.w, 2, X(66), X(36), { w: 900, lh: 1.15 });
        tf(W / 2, A.y + pinH / 2, { s: e }, () => {
          byline(it.p, S.i, A.x, A.y, X(52), { color: '#fff', sub: 'rgba(255,255,255,.7)', ring: '#ffe100', maxW: A.w * 0.6 });
          chips(it.p, it.card, S.t, A.x + A.w, A.y + X(2), { size: X(24) });
          drawText(l, A.x, A.y + X(66), { color: '#ffe100', stroke: '#000', sw: 0.2, align: 'center', maxW: A.w });
        });
      }
      return spots;
    },

    // 7. Terminal window that opens and types each post as a command line.
    terminal(S) {
      const c = K.ctx, A = S.A, bar = X(64), pad = X(28), ph = X(48), gap = X(22);
      const m = stack(S, 'term', { max: X(56), min: X(26), gap, avail: A.h - bar - 2 * pad, measure: (it, fs) => {
        const l = lay(it.p.text, A.w - 2 * pad, fs, { w: 600, lh: 1.3 });
        return { lay: l, h: ph + tH(l) };
      } });
      const first = S.items[0]?.card.at ?? S.start, open = E.outBack(seg(S.t, first - 0.3, first - 0.05), 1.6);
      const spots = S.items.map((it, j) => spot(it, A.x, m.y[j], A.w, m.h[j]));
      if (open <= 0) return spots;
      const grow = S.items.reduce((s, it, j) => s + (m.h[j] + gap) * E.outCubic(seg(S.t - it.card.at, 0, 0.18)), 0);
      const maxV = A.h - bar - 2 * pad, V = Math.max(X(60), grow - gap), wh = bar + 2 * pad + Math.min(V, maxV), scroll = Math.max(0, V - maxV);
      tf(W / 2, A.y, { s: open }, () => {
        shadowed(() => { rr(A.x, A.y, A.w, wh, X(22)); c.fillStyle = '#0d1117'; c.fill(); });
        rr(A.x, A.y, A.w, wh, X(22)); c.strokeStyle = col(S.i); c.lineWidth = X(4); c.stroke();
        c.save(); rr(A.x, A.y, A.w, bar, [X(22), X(22), 0, 0]); c.fillStyle = '#1c2230'; c.fill(); c.restore();
        ['#ff5f56', '#ffbd2e', '#27c93f'].forEach((dot, k) => { c.beginPath(); c.arc(A.x + X(40) + k * X(40), A.y + bar / 2, X(12), 0, TAU); c.fillStyle = dot; c.fill(); });
        K.text('body', X(26), `#${plan.sources[plan.scenes[S.i].source]?.name ?? ''} — zsh`, W / 2 + X(40), A.y + bar / 2, { align: 'center', baseline: 'middle', color: '#8b949e', w: 700, maxW: A.w - X(220) });
        c.save();
        c.beginPath(); c.rect(A.x, A.y + bar, A.w, wh - bar); c.clip();
        let y = A.y + bar + pad - scroll;
        S.items.forEach((it, j) => {
          const since = S.t - it.card.at;
          if (since < 0) return;
          const l = m.lay[j], x = A.x + pad;
          const w1 = K.text('body', X(30), `${it.p.user}@mattermost`, x, y + ph / 2, { color: '#3fb950', w: 800, baseline: 'middle', maxW: A.w * 0.45 });
          K.text('body', X(30), ` ${it.p.time} %`, x + w1, y + ph / 2, { color: '#58a6ff', w: 800, baseline: 'middle' });
          chips(it.p, it.card, S.t, A.x + A.w - pad, y + ph / 2 - X(21), { size: X(22) });
          const upto = typed(l, since, 0.04, 0.02, 0.6);
          drawText(l, x, y + ph, { color: '#e6edf3', upto });
          if (j === S.latest && Math.floor(S.t * 4) % 2 === 0) {
            const g = l.glyphs[Math.max(0, upto - 1)];
            if (g) K.fill(col(S.i), x + g.x + (upto ? g.w : 0) + X(4), y + ph + g.li * l.lineH, l.size * 0.55, l.size * 1.05);
          }
          y += m.h[j] + gap;
        });
        c.restore();
      });
      return spots;
    },

    // 8. Neon signs flickering on.
    neon(S) {
      const c = K.ctx, A = S.A, nh = X(46), padX = X(30), padY = X(22);
      const m = stack(S, 'neon', { max: X(80), min: X(32), gap: X(34), measure: (it, fs) => {
        const l = lay(it.p.text, A.w - 2 * padX, fs, { w: 900, lh: 1.2 });
        return { lay: l, h: nh + tH(l) + 2 * padY };
      } });
      return S.items.map((it, j) => {
        const y = m.y[j], h = m.h[j], since = S.t - it.card.at, neon = col(S.i + j * 2 + 1, 64);
        if (since >= 0) {
          const on = since < 0.4 ? (hashN(Math.floor(S.t * 24) + j * 31) > 0.45 ? 1 : 0.15) : 0.92 + 0.08 * Math.sin(S.t * 40 + j);
          c.save();
          c.globalAlpha *= on;
          c.shadowColor = neon; c.shadowBlur = X(26);
          rr(A.x, y, A.w, h, X(30)); c.strokeStyle = neon; c.lineWidth = X(5); c.stroke();
          K.text('body', X(30), `@${it.p.user} ${it.p.time}${where(it.p, S.i)}`, A.x + padX, y + padY + nh / 2, { color: neon, w: 900, baseline: 'middle', maxW: A.w * 0.6 });
          drawText(m.lay[j], A.x + padX, y + padY + nh, { color: '#fff', stroke: neon, sw: 0.08, upto: typed(m.lay[j], since, 0.02, 0.008, 0.3) });
          c.restore();
          chips(it.p, it.card, S.t, A.x + A.w - X(18), y - X(26), { size: X(26) });
        }
        return spot(it, A.x, y, A.w, h);
      });
    },

    // 9. Manga speech balloons; shouty posts get a spiky balloon and a sound effect.
    manga(S) {
      const c = K.ctx, A = S.A, r = X(50), pad = X(30), maxB = A.w - 2 * r - X(50);
      const shout = (p) => /[!！]/.test(p.text) || reactionsOf(p) >= 8;
      const m = stack(S, 'manga', { max: X(56), min: X(28), gap: X(30), measure: (it, fs) => {
        const extra = shout(it.p) ? X(70) : 0, l = lay(it.p.text, maxB - 2 * pad - extra, fs, { w: 900, lh: 1.2 });
        return { lay: l, h: 2 * pad + tH(l) + extra * 0.8, bw: lW(l) + 2 * pad + extra, extra };
      } });
      return S.items.map((it, j) => {
        const mm = m.ms[j], y = m.y[j], h = mm.h, bw = mm.bw, left = j % 2 === 0, since = S.t - it.card.at;
        const ax = left ? A.x + r : A.x + A.w - r, bx = left ? A.x + 2 * r + X(40) : A.x + A.w - 2 * r - X(40) - bw;
        if (since >= -0.1) {
          const fe = E.outBack(seg(since, -0.1, 0.08), 2.4);
          tf(ax, y + h - r, { s: fe }, () => {
            face(it.p.userId, it.p.user, ax, y + h - r, r, '#000');
            K.text('body', X(22), `@${it.p.user}`, ax, y + h + X(24), { align: 'center', color: '#fff', w: 900, maxW: 2 * r + X(40) });
          });
        }
        if (since >= 0) {
          const e = E.outElastic(seg(since, 0, 0.5)), tx = left ? bx : bx + bw;
          tf(tx, y + h - X(20), { s: e }, () => {
            c.beginPath();
            if (mm.extra) {
              const cx = bx + bw / 2, cy = y + h / 2, n = 26;
              for (let k = 0; k <= 2 * n; k++) {
                const th = k / (2 * n) * TAU, rad = k % 2 ? 1.08 : 1.26 + 0.12 * rnd(S.i, j, k);
                c[k ? 'lineTo' : 'moveTo'](cx + Math.cos(th) * bw / 2 * rad, cy + Math.sin(th) * h / 2 * rad);
              }
            } else c.roundRect(bx, y, bw, h, Math.min(h / 2, X(56)));
            c.fillStyle = '#fff'; c.fill(); c.strokeStyle = '#000'; c.lineWidth = X(6); c.stroke();
            if (!mm.extra) {
              c.beginPath();
              const bx0 = left ? bx + X(30) : bx + bw - X(30);
              c.moveTo(bx0, y + h - X(8)); c.lineTo(left ? bx - X(34) : bx + bw + X(34), y + h + X(10)); c.lineTo(left ? bx0 + X(40) : bx0 - X(40), y + h - X(8));
              c.fillStyle = '#fff'; c.fill(); c.stroke();
              c.fillRect(Math.min(bx0, left ? bx0 + X(40) : bx0 - X(40)) + X(4), y + h - X(14), X(32), X(12));
            }
            drawText(mm.lay, bx + (bw - lW(mm.lay)) / 2, y + (h - tH(mm.lay)) / 2 + X(4), { color: '#000' });
          });
          if (mm.extra) {
            const se = E.outBack(seg(since, 0.1, 0.3), 3);
            if (se > 0) tf(left ? bx + bw - X(40) : bx + X(40), y - X(10), { s: se, r: left ? 0.2 : -0.2 }, () =>
              K.text('display', X(64), reactionsOf(it.p) >= 8 ? 'ドドンッ' : 'バーン', left ? bx + bw - X(40) : bx + X(40), y - X(10),
                { align: 'center', baseline: 'middle', color: '#ffe100', w: 900 }));
          }
          chips(it.p, it.card, S.t, left ? bx + bw : bx + bw, y - X(34), { size: X(24) });
        }
        return spot(it, bx, y, bw, h);
      });
    },

    // 10. TV news: lower-third bars wiping in, a ticker running underneath.
    news(S) {
      const c = K.ctx, A = S.A, tick = X(76), lw = X(230), pad = X(22);
      const m = stack(S, 'news', { max: X(62), min: X(28), gap: X(18), avail: A.h - tick - X(26), measure: (it, fs) => {
        const l = lay(it.p.text, A.w - lw - 2 * pad, fs, { w: 800, lh: 1.22 });
        return { lay: l, h: Math.max(X(124), 2 * pad + tH(l)) };
      } });
      const spots = S.items.map((it, j) => {
        const y = m.y[j], h = m.h[j], since = S.t - it.card.at;
        if (since >= 0) {
          const q1 = E.outExpo(seg(since, 0, 0.18)), q2 = E.outExpo(seg(since, 0.06, 0.3));
          c.save(); c.beginPath(); c.rect(A.x, y, lw * q1, h); c.clip();
          K.fill(j % 2 ? '#0b3d91' : '#e5162b', A.x, y, lw, h);
          face(it.p.userId, it.p.user, A.x + X(46), y + X(46), X(28), '#fff');
          K.text('body', X(24), it.p.time, A.x + X(86), y + X(46), { color: '#fff', w: 900, baseline: 'middle' });
          K.text('body', X(28), `@${it.p.user}`, A.x + X(18), y + X(100), { color: '#fff', w: 900, baseline: 'middle', maxW: lw - X(28) });
          c.restore();
          c.save(); c.beginPath(); c.rect(A.x + lw, y, (A.w - lw) * q2, h); c.clip();
          K.fill('#fff', A.x + lw, y, A.w - lw, h);
          K.fill(col(S.i), A.x + lw, y, A.w - lw, X(8));
          drawText(m.lay[j], A.x + lw + pad, y + (h - tH(m.lay[j])) / 2 + (1 - q2) * X(40), { color: '#111' });
          c.restore();
          chips(it.p, it.card, S.t, A.x + A.w - X(10), y - X(20), { size: X(22) });
        }
        return spot(it, A.x, y, A.w, h);
      });
      const q = E.outExpo(seg(S.t, S.start, S.start + 0.3)), ty = A.y + A.h - tick;
      c.save(); c.beginPath(); c.rect(W * (1 - q), ty, W, tick); c.clip();
      K.fill('#000', 0, ty, W, tick);
      const str = S.items.map((it) => `@${it.p.user}「${it.p.text}」`).join('　◆　') + '　◆　';
      K.font('body', X(34), { w: 800 });
      const sw = c.measureText(str).width, x0 = X(170) - ((S.t * X(320)) % sw);
      c.fillStyle = '#fff'; c.textBaseline = 'middle';
      for (let x = x0; x < W; x += sw) c.fillText(str, x, ty + tick / 2);
      K.fill('#ffe100', 0, ty, X(160), tick);
      K.text('body', X(34), 'LIVE', X(80), ty + tick / 2, { align: 'center', baseline: 'middle', color: '#000', w: 900 });
      c.restore();
      return spots;
    },

    // 11. Coloured cards swinging down like flaps hinged on their top edge.
    flip(S) {
      const c = K.ctx, A = S.A, m = stack(S, 'flip', { max: X(70), min: X(28), gap: X(26), measure: boxMeasure(A.w) });
      return S.items.map((it, j) => {
        const y = m.y[j], h = m.h[j], since = S.t - it.card.at;
        if (since >= 0) {
          const th = lerp(-Math.PI / 2, 0, E.outBack(seg(since, 0, 0.4), 1.8)), sy = Math.max(0.02, Math.cos(th));
          tf(A.x + A.w / 2, y, { sy }, () => {
            postBox(S, it, A.x, y, A.w, h, m, { bg: col(S.i + j * 1.5, 40), fg: '#fff', sub: 'rgba(255,255,255,.75)', ring: '#fff', glow: false, chips: false });
            rr(A.x, y, A.w, h, X(30)); c.fillStyle = `rgba(0,0,0,${0.75 * (1 - sy)})`; c.fill();
            const g = seg(since, 0.35, 0.8);
            if (g > 0 && g < 1) {
              c.save(); rr(A.x, y, A.w, h, X(30)); c.clip();
              const gx = A.x + lerp(-X(200), A.w + X(200), g);
              c.beginPath(); c.moveTo(gx, y); c.lineTo(gx + X(90), y); c.lineTo(gx - X(30), y + h); c.lineTo(gx - X(120), y + h);
              c.fillStyle = 'rgba(255,255,255,.25)'; c.fill(); c.restore();
            }
          });
          chips(it.p, it.card, S.t, A.x + A.w - X(18), y - X(28), { size: X(28) });
        }
        return spot(it, A.x, y, A.w, h);
      });
    },

    // 12. Split-flap departure board: every character rattles through letters before it settles.
    flap(S) {
      const c = K.ctx, A = S.A, rowsOf = (it, cols) => 1 + Math.ceil(graphemes(it.p.text).length / cols);
      const m = fit(`flap${S.i}`, X(86), X(38), (cs) => {
        const cols = Math.floor((A.w - X(24)) / cs), rows = S.items.map((it) => rowsOf(it, cols));
        return { cs, cols, rows, total: rows.reduce((s, r) => s + r, 0) * cs * 1.18 + X(18) * (rows.length - 1) + X(24) };
      }, A.h);
      const { cs, cols } = m, ch = cs * 1.18, x0 = A.x + (A.w - cols * cs) / 2, spots = [];
      const boardH = Math.min(A.h, m.total), by = A.y + Math.max(0, (A.h - m.total) / 2);
      shadowed(() => { rr(A.x - X(12), by - X(12), A.w + X(24), boardH + X(24), X(20)); c.fillStyle = '#070709'; c.fill(); });
      let y = by + X(12);
      S.items.forEach((it, j) => {
        const since = S.t - it.card.at, name = graphemes(`@${it.p.user} ${it.p.time}`).slice(0, cols), text = graphemes(it.p.text);
        spots.push(spot(it, x0, y, cols * cs, m.rows[j] * ch));
        const cell = (s, k, cx, cy, color) => {
          c.fillStyle = '#1b1d24'; c.beginPath(); c.roundRect(cx + cs * 0.04, cy + ch * 0.04, cs * 0.92, ch * 0.92, cs * 0.1); c.fill();
          const d = since - k * 0.01;
          let show = d < 0 ? '' : d < 0.26 ? FLAP_POOL[Math.floor(hashN(Math.floor(S.t * 25) * 31 + k + j * 977) * FLAP_POOL.length)] : s;
          if (show && show !== ' ') {
            const sy = d >= 0 && d < 0.26 ? Math.abs(Math.cos(d * 60)) : 1;
            tf(cx + cs / 2, cy + ch / 2, { sy }, () => {
              if (/\p{Extended_Pictographic}/u.test(show)) emo(show, cx + cs / 2, cy + ch / 2, cs * 0.78);
              else K.text('body', cs * 0.7, show, cx + cs / 2, cy + ch / 2 + cs * 0.04, { align: 'center', baseline: 'middle', color, w: 900 });
            });
          }
          K.fill('rgba(0,0,0,.7)', cx + cs * 0.04, cy + ch / 2 - X(1.5), cs * 0.92, X(3));
        };
        name.forEach((s, k) => cell(s, k, x0 + k * cs, y, col(S.i + j, 66)));
        text.forEach((s, k) => cell(s, k + name.length, x0 + (k % cols) * cs, y + ch * (1 + Math.floor(k / cols)), '#f5f3ea'));
        if (since >= 0) chips(it.p, it.card, S.t, x0 + cols * cs, y + (ch - X(45)) / 2, { size: X(24) });
        y += m.rows[j] * ch + X(18);
      });
      return spots;
    },

    // 13. Tilted marquee bands: each post scrolls endlessly across the screen.
    marquee(S) {
      const c = K.ctx, A = S.A, n = S.items.length, B = Math.max(n, 5), gap = X(20);
      const bh = Math.min(X(190), (A.h - gap * (B - 1)) / B), fs = bh * 0.5, y0 = A.y + (A.h - (B * bh + (B - 1) * gap)) / 2, spots = [];
      for (let b = 0; b < B; b++) {
        const it = S.items[b % n], j = b % n, at = it.card.at + Math.floor(b / n) * 0.12, since = S.t - at, y = y0 + b * (bh + gap);
        if (b < n) spots.push(spot(it, A.x, y, A.w, bh));
        if (since < 0) continue;
        const dir = b % 2 ? 1 : -1, slide = (1 - E.outExpo(seg(since, 0, 0.3))) * dir * W * 1.2, dark = b % 2 === 1;
        const unit = `@${it.p.user} ▶ ${it.p.text}　✦　`;
        c.save();
        c.translate(W / 2 + slide, y + bh / 2); c.rotate(dir * 0.05); c.translate(-W / 2, -(y + bh / 2));
        K.fill(dark ? '#000' : col(S.i + j, 60), -X(200), y, W + X(400), bh);
        K.font('body', fs, { w: 900 });
        const uw = c.measureText(unit).width + bh, x1 = -X(200) - ((S.t * X(260) * -dir % uw) + uw) % uw;
        c.textBaseline = 'middle';
        for (let x = x1; x < W + X(200); x += uw) {
          face(it.p.userId, it.p.user, x + bh * 0.4, y + bh / 2, bh * 0.32, dark ? col(S.i + j, 60) : '#000');
          c.fillStyle = dark ? col(S.i + j, 66) : '#000'; K.font('body', fs, { w: 900 }); c.fillText(unit, x + bh * 0.85, y + bh / 2 + fs * 0.05);
        }
        c.restore();
        if (b < n) chips(it.p, it.card, S.t, W - X(40), y - X(14), { size: X(24) });
      }
      return spots;
    },

    // 14. Bento grid: the most-reacted post gets the wide tile, tiles zoom out of nothing.
    bento(S) {
      const c = K.ctx, A = S.A, gap = X(22), pad = X(26), bh = X(52);
      const order = S.items.map((it, j) => j).sort((a, b) => reactionsOf(S.items[b].p) - reactionsOf(S.items[a].p));
      const rows = [[order[0]]];
      for (let k = 1; k < order.length; k += 2) rows.push(order.slice(k, k + 2));
      const m = fit(`bento${S.i}`, X(60), X(26), (fs) => {
        let y = 0;
        const tiles = [];
        rows.forEach((row, ri) => {
          const tw = row.length === 1 ? A.w : (A.w - gap) / 2, size = ri === 0 ? fs * 1.3 : fs;
          const ls = row.map((j) => lay(S.items[j].p.text, tw - 2 * pad, size, { w: 900, lh: 1.2 }));
          const rh = Math.max(...ls.map((l) => 2 * pad + bh + X(10) + tH(l)));
          row.forEach((j, k) => { tiles[j] = { x: A.x + k * (tw + gap), y, w: tw, h: rh, lay: ls[k] }; });
          y += rh + gap;
        });
        return { tiles, total: y - gap };
      }, A.h);
      const y0 = A.y + Math.max(0, (A.h - m.total) / 2);
      return S.items.map((it, j) => {
        const tl = m.tiles[j], y = y0 + tl.y, since = S.t - it.card.at;
        if (since >= 0) {
          const e = E.outBack(seg(since, 0, 0.3), 2.2), top = it.p.reactions[0]?.emoji ?? S.list[j % S.list.length];
          tf(tl.x + tl.w / 2, y + tl.h / 2, { s: e, r: (1 - e) * 0.3 * (j % 2 ? 1 : -1) }, () => {
            rr(tl.x, y, tl.w, tl.h, X(34)); c.fillStyle = col(S.i + j * 2, 62); c.fill();
            c.save(); rr(tl.x, y, tl.w, tl.h, X(34)); c.clip();
            emo(top, tl.x + tl.w - X(70), y + tl.h - X(60), Math.min(tl.h * 0.9, X(220)), 0.25, 0.32);
            c.restore();
            byline(it.p, S.i, tl.x + pad, y + pad, bh, { color: '#000', sub: 'rgba(0,0,0,.6)', ring: '#000', maxW: tl.w - 2 * pad });
            drawText(tl.lay, tl.x + pad, y + pad + bh + X(10), { color: '#000', upto: typed(tl.lay, since) });
          });
          chips(it.p, it.card, S.t, tl.x + tl.w - X(10), y - X(22), { size: X(24) });
        }
        return spot(it, tl.x, y, tl.w, tl.h);
      });
    },

    // 15. Cards rush out of a vanishing point with motion ghosts.
    tunnel(S) {
      const A = S.A, m = stack(S, 'tunnel', { max: X(70), min: X(28), gap: X(30), measure: boxMeasure(A.w) });
      const vx = W / 2, vy = A.y - X(60);
      return S.items.map((it, j) => {
        const y = m.y[j], h = m.h[j], since = S.t - it.card.at;
        const at = (q) => {
          const e = E.outBack(q, 1.4), p = E.outCubic(q), cx = lerp(vx, A.x + A.w / 2, p), cy = lerp(vy, y + h / 2, p);
          return { s: lerp(0.04, 1, e), dx: cx - (A.x + A.w / 2), dy: cy - (y + h / 2) };
        };
        const draw = (q, a, o) => {
          const f = at(q);
          K.ctx.save(); K.ctx.translate(f.dx, f.dy);
          tf(A.x + A.w / 2, y + h / 2, { s: f.s, a }, () => postBox(S, it, A.x, y, A.w, h, m, o));
          K.ctx.restore();
        };
        if (since >= 0) {
          const q = seg(since, 0, 0.32), o = { bg: 'rgba(12,14,30,.86)', fg: '#fff', sub: '#9aa3b5', border: col(S.i + j, 62), borderW: X(5), shadow: false, glow: false };
          if (q < 1) [0.3, 0.18].forEach((d) => { if (q - d > 0) draw(q - d, 0.22, { ...o, typed: false, chips: false }); });
          draw(q, 1, o);
        }
        return spot(it, A.x, y, A.w, h);
      });
    },

    // 16. Rubber stamps slammed onto paper (the whole sheet shakes on impact).
    stamp(S) {
      const c = K.ctx, A = S.A, pad = X(24), nh = X(40);
      const m = stack(S, 'stamp', { max: X(60), min: X(28), gap: X(30), avail: A.h - X(20), top: A.y + X(10), measure: (it, fs) => {
        const l = lay(it.p.text, A.w - 2 * pad - X(90), fs, { w: 900, lh: 1.2 });
        K.font('body', X(28), { w: 900 });
        return { lay: l, h: 2 * pad + nh + tH(l), bw: Math.max(lW(l), K.ctx.measureText(`@${it.p.user} · ${it.p.time}`).width) + 2 * pad };
      } });
      const shake = S.items.reduce((s, it) => s + (S.t >= it.card.at + 0.12 ? Math.exp(-(S.t - it.card.at - 0.12) * 14) : 0), 0) * X(16);
      c.save();
      c.translate((hashN(Math.floor(S.t * 30)) - 0.5) * shake, (hashN(Math.floor(S.t * 30) + 5) - 0.5) * shake);
      const sh = sheet(S, '#f4efe1');
      for (let ly = sh.y + X(70); ly < sh.y + sh.h; ly += X(58)) K.fill('rgba(60,110,200,.12)', sh.x, ly, sh.w, X(2));
      sh.done();
      const spots = S.items.map((it, j) => {
        const mm = m.ms[j], y = m.y[j], x = A.x + (A.w - mm.bw) / 2 + (j % 2 ? X(34) : -X(34)), since = S.t - it.card.at;
        if (since >= 0) {
          const q = seg(since, 0, 0.12), s = lerp(2.6, 1, E.inCubic(q)), ink = j % 3 === 2 ? '#1d4ed8' : '#d7263d';
          tf(x + mm.bw / 2, y + mm.h / 2, { s, r: (rnd(S.i, j, 4) - 0.5) * 0.14, a: q < 1 ? q * 0.7 : 0.9 }, () => {
            rr(x, y, mm.bw, mm.h, X(14)); c.strokeStyle = ink; c.lineWidth = X(8); c.stroke();
            rr(x + X(10), y + X(10), mm.bw - X(20), mm.h - X(20), X(8)); c.lineWidth = X(3); c.stroke();
            K.text('body', X(28), `@${it.p.user} · ${it.p.time}`, x + pad, y + pad + nh / 2, { color: ink, w: 900, baseline: 'middle' });
            drawText(mm.lay, x + pad, y + pad + nh, { color: ink });
            for (let k = 0; k < 26; k++) {
              c.beginPath();
              c.arc(x + rnd(S.i, j, k, 1) * mm.bw, y + rnd(S.i, j, k, 2) * mm.h, X(2 + 5 * rnd(S.i, j, k, 3)), 0, TAU);
              c.fillStyle = '#f4efe1'; c.fill();
            }
          });
          chips(it.p, it.card, S.t, x + mm.bw + X(20), y - X(20), { size: X(24) });
        }
        return spot(it, x, y, mm.bw, mm.h);
      });
      c.restore();
      return spots;
    },

    // 17. Timeline: the line draws down to each time node, then the post slides in.
    timeline(S) {
      const c = K.ctx, A = S.A, lx = A.x + X(30), cx0 = A.x + X(80), cw = A.x + A.w - cx0, timeH = X(52);
      const inner = boxMeasure(cw, { bh: X(54) });
      const m = stack(S, 'timeline', { max: X(66), min: X(26), gap: X(18), measure: (it, fs) => { const b = inner(it, fs); return { lay: b.lay, h: b.h + timeH }; } });
      const L = S.items.reduce((mx, it, j) => (S.t >= it.card.at ? j : mx), -1);
      if (L >= 0) {
        const node = (k) => (k < 0 ? A.y : m.y[k] + timeH / 2);
        const end = lerp(node(L - 1), node(L), E.outCubic(seg(S.t - S.items[L].card.at, 0, 0.14)));
        c.save(); c.shadowColor = col(S.i); c.shadowBlur = X(20);
        K.fill(col(S.i), lx - X(4), A.y, X(8), end - A.y);
        c.restore();
      }
      return S.items.map((it, j) => {
        const y = m.y[j], h = m.h[j], since = S.t - it.card.at;
        if (since >= 0) {
          const ne = E.outBack(seg(since, 0.1, 0.25), 3);
          c.beginPath(); c.arc(lx, y + timeH / 2, X(18) * ne, 0, TAU); c.fillStyle = col(S.i); c.fill();
          c.lineWidth = X(5); c.strokeStyle = '#fff'; c.stroke();
          const e = E.outCubic(seg(since, 0.12, 0.34));
          if (e > 0) {
            const x = cx0 + (1 - e) * X(320);
            tf(x + cw / 2, y + h / 2, { a: e }, () => {
              K.text('body', X(40), it.p.time, x, y + timeH / 2, { color: col(S.i, 72), w: 900, baseline: 'middle' });
              postBox(S, it, x, y + timeH, cw, h - timeH, m, { bg: '#fff', bh: X(54) });
            });
          }
        }
        return spot(it, cx0, y + timeH, cw, h - timeH);
      });
    },

    // 18. Full-bleed colour stripes that stretch to fill the screen, wiping in on a slant.
    stripes(S) {
      const c = K.ctx, A = S.A, pad = X(24), m = stack(S, 'stripes', { max: X(64), min: X(28), gap: 0, measure: boxMeasure(A.w, { pad, bh: X(56), weight: 900 }) });
      const k = m.fits ? A.h / m.total : 1;
      let y = A.y;
      return S.items.map((it, j) => {
        const nat = m.h[j], h = m.fits ? nat * k : (A.h / S.items.length), yy = y, since = S.t - it.card.at;
        y += h;
        if (since >= 0) {
          const q = E.outExpo(seg(since, 0, 0.26)), fromLeft = j % 2 === 0, sk = X(140);
          c.save();
          c.beginPath();
          if (fromLeft) { const e = lerp(-sk, W + sk, q); c.moveTo(0, yy); c.lineTo(e + sk, yy); c.lineTo(e, yy + h + 1); c.lineTo(0, yy + h + 1); }
          else { const e = lerp(W + sk, -sk, q); c.moveTo(W, yy); c.lineTo(e, yy); c.lineTo(e + sk, yy + h + 1); c.lineTo(W, yy + h + 1); }
          c.clip();
          K.fill(col(S.i + j * 1.5, j % 2 ? 50 : 60), 0, yy, W, h + 1);
          K.text('display', Math.min(h * 0.85, X(260)), String(j + 1).padStart(2, '0'), W - X(30), yy + h / 2 + h * 0.05,
            { align: 'right', baseline: 'middle', color: 'rgba(0,0,0,.16)', w: 900 });
          const ty = yy + Math.max(0, (h - nat) / 2);
          byline(it.p, S.i, A.x, ty + pad, X(56), { color: '#000', sub: 'rgba(0,0,0,.6)', ring: '#000', maxW: A.w });
          drawText(m.lay[j], A.x, ty + pad + X(66), { color: '#000', upto: typed(m.lay[j], since, 0.1) });
          c.restore();
          chips(it.p, it.card, S.t, A.x + A.w, yy + X(10), { size: X(24) });
        }
        return spot(it, 0, yy, W, h);
      });
    },

    // 19. Karaoke lyrics: the colour sweeps through each quote under a bouncing emoji.
    karaoke(S) {
      const A = S.A, nh = X(58), m = stack(S, 'karaoke', { max: X(80), min: X(36), gap: X(34), measure: (it, fs) => {
        const l = lay(it.p.text, A.w, fs, { w: 900, lh: 1.22 });
        return { lay: l, h: nh + X(8) + tH(l) };
      } });
      return S.items.map((it, j) => {
        const y = m.y[j], l = m.lay[j], since = S.t - it.card.at, n = l.glyphs.length;
        if (since >= 0) {
          const dim = j === S.latest ? 1 : 0.7;
          K.pill(W / 2, y, `@${it.p.user} ${it.p.time}`, { align: 'center', size: 26, w: 900, bg: col(S.i + j), fg: '#000', alpha: dim, scaleX: E.outBack(seg(since, 0, 0.2), 2) });
          const sung = n * seg(since, 0.08, 0.08 + Math.min(1.3, n * 0.035)), ty = y + nh + X(8);
          drawGlyphs(l, A.x, ty, (g, k) => ({ a: dim * clamp(since * 5), color: k < sung ? '#ffe100' : 'rgba(255,255,255,.55)',
            s: 1 + 0.3 * Math.exp(-Math.abs(sung - k - 0.5) * 2) * (sung < n ? 1 : 0) }), { stroke: '#000', sw: 0.2, align: 'center', maxW: A.w });
          if (sung > 0 && sung < n) {
            const g = l.glyphs[Math.floor(sung)];
            const gx = K.lineX(l, g.li, A.x, A.w, 'center') + g.x + g.w / 2;
            emo(S.list[j % S.list.length], gx, ty + g.li * l.lineH - X(30) - Math.abs(Math.sin(S.t * TAU * 2)) * X(34), X(56));
          }
          chips(it.p, it.card, S.t, A.x + A.w, y + X(2), { size: X(24) });
        }
        return spot(it, A.x, y, A.w, m.h[j]);
      });
    },

    // 20. Glitch: cards tear in as jittering slices with RGB ghosts.
    glitch(S) {
      const c = K.ctx, A = S.A, m = stack(S, 'glitch', { max: X(70), min: X(28), gap: X(30), measure: boxMeasure(A.w) });
      return S.items.map((it, j) => {
        const y = m.y[j], h = m.h[j], since = S.t - it.card.at, fr = Math.floor(S.t * 30);
        const o = { bg: '#0b0b14', fg: '#f0f0ff', sub: '#8a8aa0', border: col(S.i + j, 62), borderW: X(4), glow: false, shadow: false };
        if (since >= 0) {
          const q = seg(since, 0, 0.32), beat = kickEnv(S.t, 30) > 0.7 && j === S.latest;
          const amp = q < 1 ? 1 - q : beat ? 0.12 : 0;
          if (amp > 0) {
            [['rgba(255,0,90,.8)', -1], ['rgba(0,240,255,.8)', 1]].forEach(([tint, d]) => {
              c.save(); c.translate(d * X(16) * amp, 0); c.globalCompositeOperation = 'lighter';
              postBox(S, it, A.x, y, A.w, h, m, { fg: tint, sub: tint, border: tint, borderW: X(4), glow: false, avatar: false, chips: false, typed: false });
              c.restore();
            });
            for (let s = 0; s < 7; s++) {
              const dx = (hashN(fr * 13 + s + j * 7) - 0.5) * X(180) * amp, sy = y + (h * s) / 7;
              c.save(); c.beginPath(); c.rect(A.x - X(200), sy, A.w + X(400), h / 7 + 1); c.clip(); c.translate(dx, 0);
              postBox(S, it, A.x, y, A.w, h, m, o);
              c.restore();
            }
            if (q < 1) K.fill(col(S.i + fr, 60, 0.6), A.x + hashN(fr + j) * A.w * 0.7, y + hashN(fr + j + 3) * h, A.w * 0.3, X(10));
          } else postBox(S, it, A.x, y, A.w, h, m, o);
          chips(it.p, it.card, S.t, A.x + A.w - X(18), y - X(26), { size: X(26) });
        }
        return spot(it, A.x, y, A.w, h);
      });
    },

    // 21. A receipt printing out of a slot, one line item per post, totals at the bottom.
    receipt(S) {
      const c = K.ctx, A = S.A, pw = Math.min(A.w, X(840)), px = A.x + (A.w - pw) / 2, pad = X(34), head = X(170), foot = X(150), row = X(46), sep = X(30);
      const m = stack(S, 'receipt', { max: X(60), min: X(24), gap: 0, avail: A.h - head - foot - X(40), top: 0, align: 'top', measure: (it, fs) => {
        const l = lay(it.p.text, pw - 2 * pad, fs, { w: 700, lh: 1.25 });
        return { lay: l, h: row + tH(l) + sep };
      } });
      const slotY = A.y, py = slotY + X(14), all = S.items.at(-1), open = E.outCubic(seg(S.t, S.start, S.start + 0.3));
      const L = head * open + S.items.reduce((s, it, j) => s + m.h[j] * E.outCubic(seg(S.t - it.card.at, 0, 0.2)), 0)
        + (all ? foot * E.outCubic(seg(S.t - all.card.at, 0.35, 0.6)) : 0);
      const dash = (y) => { for (let x = px + pad; x < px + pw - pad; x += X(22)) K.fill('#999', x, y, X(12), X(3)); };
      const spots = [];
      c.save();
      c.beginPath(); c.rect(px - X(20), py, pw + X(40), L + X(20)); c.clip();
      shadowed(() => {
        c.beginPath(); c.moveTo(px, py); c.lineTo(px + pw, py); c.lineTo(px + pw, py + L);
        for (let x = px + pw, k = 0; x > px; x -= X(20), k++) c.lineTo(x - X(10), py + L + (k % 2 ? 0 : X(12)));
        c.lineTo(px, py + L); c.closePath(); c.fillStyle = '#fbfbf5'; c.fill();
      }, X(24), X(8));
      K.text('body', X(40), '🧾 MATTERMOST', px + pw / 2, py + X(56), { align: 'center', color: '#111', w: 900 });
      K.text('body', X(28), `#${plan.sources[plan.scenes[S.i].source]?.name ?? ''}  ${plan.date.replaceAll('-', '.')}`, px + pw / 2, py + X(106),
        { align: 'center', color: '#555', w: 700, maxW: pw - 2 * pad });
      dash(py + head - X(26));
      let y = py + head;
      S.items.forEach((it, j) => {
        spots.push(spot(it, px, y, pw, m.h[j]));
        K.text('body', X(30), `@${it.p.user}`, px + pad, y + row / 2, { color: '#111', w: 900, baseline: 'middle', maxW: pw * 0.45 });
        const tags = [...it.p.reactions.map((r) => `${r.emoji}${r.count}`), ...(it.p.replies ? [`💬${it.p.replies}`] : []), it.p.time].join(' ');
        K.text('body', X(26), tags, px + pw - pad, y + row / 2, { align: 'right', color: '#333', w: 700, baseline: 'middle', maxW: pw * 0.5 });
        drawText(m.lay[j], px + pad, y + row, { color: '#222' });
        dash(y + m.h[j] - sep / 2);
        y += m.h[j];
      });
      const total = S.items.reduce((s, it) => s + reactionsOf(it.p), 0);
      K.text('body', X(40), 'TOTAL', px + pad, y + X(50), { color: '#111', w: 900 });
      K.text('body', X(40), `🔥 × ${total}`, px + pw - pad, y + X(50), { align: 'right', color: '#111', w: 900 });
      for (let x = px + pad, k = 0; x < px + pw - pad; k++) { const bw = X(3 + 7 * rnd(S.i, k, 5)); if (k % 2 === 0) K.fill('#111', x, y + X(76), bw, X(52)); x += bw; }
      c.restore();
      shadowed(() => { rr(px - X(40), slotY - X(4), pw + X(80), X(30), X(15)); c.fillStyle = '#23262f'; c.fill(); }, X(10), X(4));
      return spots;
    },

    // 22. The post's top reaction lands first, then the card bursts out of it.
    emojipop(S) {
      const c = K.ctx, A = S.A, pad = X(30), badge = X(60);
      const m = stack(S, 'emojipop', { max: X(70), min: X(28), gap: X(34), measure: boxMeasure(A.w, { pad, ix: badge }) });
      return S.items.map((it, j) => {
        const y = m.y[j], h = m.h[j], since = S.t - it.card.at, em = it.p.reactions[0]?.emoji ?? S.list[j % S.list.length];
        const cx = A.x + A.w / 2, cy = y + h / 2;
        if (since >= 0) {
          const e = E.outBack(seg(since, 0, 0.26), 2.6);
          tf(cx, cy, { s: e }, () => {
            shadowed(() => {
              rr(A.x, y, A.w, h, Math.min(h / 2, X(70)));
              c.fillStyle = K.gradient([[0, col(S.i + j, 74)], [1, col(S.i + j + 1, 60)]], A.x, y, A.x + A.w, y + h); c.fill();
            });
            byline(it.p, S.i, A.x + pad + badge, y + pad, X(60), { color: '#000', sub: 'rgba(0,0,0,.6)', ring: '#000', maxW: A.w - 2 * pad - badge });
            drawText(m.lay[j], A.x + pad + badge, y + pad + X(70), { color: '#000', upto: typed(m.lay[j], since, 0.12) });
          });
          chips(it.p, it.card, S.t, A.x + A.w - X(18), y - X(26), { size: X(26) });
        }
        if (since >= -0.22) {
          const pre = E.outBack(seg(since, -0.22, -0.05), 2.5), q = E.inOutCubic(seg(since, 0, 0.25));
          emo(em, lerp(cx, A.x + X(40), q), lerp(cy, y + X(30), q), lerp(X(340), X(120), q) * pre * (1 + 0.1 * kickEnv(S.t) * q),
            lerp((1 - pre) * 3, -0.2, q));
        }
        return spot(it, A.x, y, A.w, h);
      });
    },

    // 23. Cork board: polaroids drop in and swing on their pins.
    pinboard(S) {
      const c = K.ctx, A = S.A, gap = X(28), pad = X(22), bh = X(48), one = S.items.length === 1;
      const cw = one ? A.w * 0.8 : (A.w - gap) / 2;
      const m = fit(`pinboard${S.i}`, X(66), X(26), (fs) => {
        const cols = [X(24), X(24)], out = S.items.map((it) => {
          const l = lay(it.p.text, cw - 2 * pad, fs, { w: 800 }), h = 2 * pad + bh + X(10) + tH(l);
          const k = one ? 0 : cols[0] <= cols[1] ? 0 : 1, y = cols[k];
          cols[k] += h + gap;
          return { lay: l, h, k, y };
        });
        return { out, total: Math.max(...cols) - gap };
      }, A.h);
      const sh = sheet(S, '#b98a5e', { enter: 'none', rot: 0, r: X(18) });
      for (let k = 0; k < 140; k++) { c.beginPath(); c.arc(sh.x + rnd(S.i, k, 1) * sh.w, sh.y + rnd(S.i, k, 2) * sh.h, X(2 + 3 * rnd(S.i, k, 3)), 0, TAU); c.fillStyle = 'rgba(90,55,25,.35)'; c.fill(); }
      rr(sh.x, sh.y, sh.w, sh.h, X(18)); c.strokeStyle = '#6b4a2b'; c.lineWidth = X(14); c.stroke();
      sh.done();
      const y0 = A.y + Math.max(0, (A.h - m.total) / 2);
      return S.items.map((it, j) => {
        const o = m.out[j], x = (one ? A.x + (A.w - cw) / 2 : A.x + o.k * (cw + gap)) + (rnd(S.i, j, 1) - 0.5) * X(24), y = y0 + o.y, since = S.t - it.card.at;
        if (since >= 0) {
          const base = (rnd(S.i, j, 2) - 0.5) * 0.14, s = since - 0.18;
          const rot = base + (s > 0 ? 0.4 * Math.exp(-4 * s) * Math.sin(16 * s) : 0.3);
          const dy = lerp(-X(500), 0, E.outCubic(seg(since, 0, 0.18)));
          tf(x + cw / 2, y + dy, { r: rot }, () => {
            shadowed(() => { c.fillStyle = '#fff'; c.fillRect(x, y + dy, cw, o.h); }, X(24), X(14));
            byline(it.p, S.i, x + pad, y + dy + pad, bh, { color: '#222', sub: '#666', ring: col(S.i + j), maxW: cw - 2 * pad });
            drawText(o.lay, x + pad, y + dy + pad + bh + X(10), { color: '#1a1a1a', upto: typed(o.lay, since, 0.15) });
            chips(it.p, it.card, S.t, x + cw - X(8), y + dy + o.h - X(24), { size: X(22) });
            shadowed(() => { c.beginPath(); c.arc(x + cw / 2, y + dy + X(4), X(17), 0, TAU); c.fillStyle = '#e63946'; c.fill(); }, X(8), X(6));
            c.beginPath(); c.arc(x + cw / 2 - X(5), y + dy - X(2), X(5), 0, TAU); c.fillStyle = 'rgba(255,255,255,.7)'; c.fill();
          });
        }
        return spot(it, x, y, cw, o.h);
      });
    },

    // 24. Magazine page: pull quotes rise out of their lines, alternating sides.
    magazine(S) {
      const c = K.ctx, A = S.A, mast = X(54), qm = X(80);
      const m = stack(S, 'magazine', { max: X(66), min: X(30), gap: X(36), avail: A.h - mast, top: A.y + mast, measure: (it, fs) => {
        const l = lay(it.p.text, A.w - qm, fs, { w: 900, lh: 1.18 });
        return { lay: l, h: tH(l) + X(52) };
      } });
      const sh = sheet(S, '#f7f5ef', { enter: 'right', rot: 0.008 });
      K.text('body', X(24), 'THE DAILY MATTERMOST', sh.x + X(30), sh.y + X(44), { color: '#111', w: 900 });
      K.text('body', X(24), plan.date.replaceAll('-', '.'), sh.x + sh.w - X(30), sh.y + X(44), { align: 'right', color: '#111', w: 700 });
      K.fill('#111', sh.x + X(30), sh.y + X(58), sh.w - X(60), X(3));
      sh.done();
      return S.items.map((it, j) => {
        const y = m.y[j], l = m.lay[j], since = S.t - it.card.at, right = j % 2 === 1, tx = right ? A.x : A.x + qm;
        if (since >= 0) {
          K.text('display', X(150) * E.outBack(seg(since, 0, 0.2), 2), '“', right ? A.x + A.w - X(10) : A.x, y + X(90),
            { align: right ? 'right' : 'left', color: col(S.i + j, 48), w: 900 });
          l.lines.forEach((_, li) => {
            const q = E.outExpo(seg(since, li * 0.05, li * 0.05 + 0.3));
            if (q <= 0) return;
            c.save(); c.beginPath(); c.rect(A.x - X(10), y + li * l.lineH, A.w + X(20), l.lineH); c.clip();
            drawGlyphs(l, tx, y + (1 - q) * l.lineH, (g) => (g.li === li ? {} : null), { color: '#111', align: right ? 'right' : 'left', maxW: A.w - qm });
            c.restore();
          });
          const q = E.outCubic(seg(since, 0.15, 0.4));
          K.text('body', X(28), `— @${it.p.user}, ${it.p.time}${where(it.p, S.i)}`, right ? A.x + A.w - qm : tx, y + tH(l) + X(30),
            { align: right ? 'right' : 'left', color: col(S.i + j, 38), w: 800, maxW: A.w - qm });
          if (j < S.items.length - 1) K.fill('#111', A.x, y + m.h[j] + X(16), A.w * q, X(2));
          chips(it.p, it.card, S.t, right ? A.x + X(0) : A.x + A.w, y + tH(l) + X(8), { size: X(22), align: right ? 'left' : 'right' });
        }
        return spot(it, A.x, y, A.w, m.h[j]);
      });
    },

    // 25. 3D extruded words popping out of the screen one by one.
    extrude(S) {
      const A = S.A, nh = X(58), depth = 6;
      const m = stack(S, 'extrude', { max: X(84), min: X(38), gap: X(30), measure: (it, fs) => {
        const l = lay(it.p.text, A.w - X(24), fs, { w: 900, lh: 1.2 });
        return { lay: l, h: nh + X(10) + tH(l) };
      } });
      return S.items.map((it, j) => {
        const y = m.y[j], l = m.lay[j], since = S.t - it.card.at;
        if (since >= 0) {
          const pw = K.pill(A.x, y, `@${it.p.user} · ${it.p.time}`, { size: 25, w: 900, bg: '#fff', fg: '#000', scaleX: E.outBack(seg(since, 0, 0.2), 2) });
          chips(it.p, it.card, S.t, A.x + pw + X(14), y + X(3), { size: X(24), align: 'left' });
          const units = new Map();
          l.glyphs.forEach((g) => { if (!units.has(g.i0)) units.set(g.i0, units.size); });
          const pop = (g) => E.outBack(seg(since, units.get(g.i0) * 0.04, units.get(g.i0) * 0.04 + 0.22), 3);
          const ty = y + nh + X(10), step = X(2.4);
          for (let d = depth; d >= 1; d--) {
            drawGlyphs(l, A.x, ty, (g, k) => {
              const e = pop(g);
              return e > 0 ? { s: e, dx: d * step * e, dy: d * step * e, r: (rnd(S.i, j, g.i0) - 0.5) * 0.3 * (1 - e) } : null;
            }, { color: col(S.i + j, 22 + d * 2) });
          }
          drawGlyphs(l, A.x, ty, (g) => {
            const e = pop(g);
            return e > 0 ? { s: e, r: (rnd(S.i, j, g.i0) - 0.5) * 0.3 * (1 - e) } : null;
          }, { color: col(S.i + j, 72), stroke: '#000', sw: 0.06 });
        }
        return spot(it, A.x, y, A.w, m.h[j]);
      });
    },
  };

  // Every topic gets a different look; the order is reshuffled each day.
  function order() {
    const ids = Object.keys(STYLES);
    for (let k = ids.length - 1; k > 0; k--) {
      const r = Math.floor(hashN(seed + k * 7919) * (k + 1));
      [ids[k], ids[r]] = [ids[r], ids[k]];
    }
    return ids;
  }

  // Ghost wall of the day's quotes, scrolling behind every topic.
  function wall(t, i) {
    const c = K.ctx, texts = posts.map((p) => p.text);
    if (!texts.length) return;
    const size = X(64), rowH = X(118);
    c.save();
    c.globalAlpha = 0.075;
    c.translate(W / 2, H / 2); c.rotate(-0.12); c.translate(-W / 2, -H / 2);
    K.font('body', size, { w: 900 });
    c.fillStyle = '#fff'; c.textBaseline = 'middle';
    for (let r = -2, y = -rowH * 2; y < H + rowH * 2; r++, y += rowH) {
      const k = ((r + i * 3) % texts.length + texts.length) % texts.length;
      const str = `${texts[k]}　✦　${texts[(k + 1) % texts.length]}　✦　`;
      const key = `wall|${str}`;
      if (!cache.has(key)) cache.set(key, c.measureText(str).width);
      const sw = cache.get(key), dir = r % 2 ? 1 : -1;
      const x0 = -X(300) - ((((t * X(110) * dir) % sw) + sw) % sw);
      for (let x = x0; x < W + X(300); x += sw) c.fillText(str, x, y);
    }
    c.restore();
  }

  return { STYLES, order, wall };
}
