// How the big white headings (each topic's summary line, and the hook headline) come on screen.
// Every style keeps the same word timing (unit k lands at 0.08 + k·0.045 s) so the score's pops
// still hit, but the motion and the lasting effect differ: drops, spins, glitches, neon, waves…
import { E, clamp, lerp, seg, TAU, hashN } from './vendor/placereel/kit.js';
import { kickEnv } from './vendor/placereel/energy.js';

export const WORD_START = 0.08, WORD_STEP = 0.045;
const POOL = [...'アイウエオカキクケコサシスセソ#@!?%&0123456789ABCDEFXYZ'];
const YELLOW = '#ffe100';

export function createHeadingStyles({ K, X, W, col, seed }) {
  // Per-glyph renderer. fn(g, k, u) → null (hidden) or { dx, dy, s, sx, sy, r, a, color, stroke, ch, fill }.
  function glyphs(lay, x, y, maxW, fn, { stroke = '#000', sw = 0.2, fill = true } = {}) {
    const c = K.ctx, units = new Map(), shown = [];
    lay.glyphs.forEach((g) => { if (!units.has(g.i0)) units.set(g.i0, units.size); });
    lay.glyphs.forEach((g, k) => { const f = fn(g, k, units.get(g.i0)); if (f) shown.push([g, f]); });
    K.font('display', lay.size, lay.opts);
    c.textBaseline = 'top'; c.lineJoin = 'round';
    for (const pass of ['stroke', 'fill']) {
      shown.forEach(([g, f]) => {
        const st = f.stroke === undefined ? stroke : f.stroke;
        if (pass === 'stroke' ? !st : f.fill === false || !fill) return;
        const gx = K.lineX(lay, g.li, x, maxW, 'left') + g.x, gy = y + g.li * lay.lineH;
        c.save();
        c.globalAlpha *= clamp(f.a ?? 1);
        c.translate(gx + g.w / 2 + (f.dx || 0), gy + lay.size / 2 + (f.dy || 0));
        c.rotate(f.r || 0); c.scale(f.sx ?? f.s ?? 1, f.sy ?? f.s ?? 1);
        if (pass === 'stroke') { c.strokeStyle = st; c.lineWidth = lay.size * (f.sw ?? sw); c.strokeText(f.ch ?? g.s, -g.w / 2, -lay.size / 2); }
        else { c.fillStyle = f.color ?? '#fff'; c.fillText(f.ch ?? g.s, -g.w / 2, -lay.size / 2); }
        c.restore();
      });
    }
  }
  const unitCount = (lay) => new Set(lay.glyphs.map((g) => g.i0)).size;
  const lineBox = (lay, x, y, maxW, li) => [K.lineX(lay, li, x, maxW, 'left'), y + li * lay.lineH, lay.lines[li].w, lay.lineH];

  // Each style: (H) => void, H = { lay, x, y, maxW, tau, t, hl, i }.
  const STYLES = {
    // Word pops with overshoot.
    pop(H) {
      glyphs(H.lay, H.x, H.y, H.maxW, (g, k, u) => {
        const e = E.outBack(seg(H.tau, at(u), at(u) + 0.14), 3);
        return e > 0 ? { s: e, color: H.color(g) } : null;
      });
    },
    // Letters fall from above and bounce on the baseline.
    drop(H) {
      glyphs(H.lay, H.x, H.y, H.maxW, (g, k, u) => {
        const q = seg(H.tau, at(u) - 0.1, at(u) + 0.25);
        return q > 0 ? { dy: -(1 - E.outBounce(q)) * X(420), r: (1 - q) * (hashN(k + seed) - 0.5), color: H.color(g) } : null;
      });
    },
    // One full turn per word, alternating direction.
    spin(H) {
      glyphs(H.lay, H.x, H.y, H.maxW, (g, k, u) => {
        const e = E.outBack(seg(H.tau, at(u), at(u) + 0.28), 1.6);
        return e > 0 ? { s: e, r: (1 - e) * TAU * (u % 2 ? 1 : -1), color: H.color(g) } : null;
      });
    },
    // Rushes in from huge, with a fading ghost.
    zoom(H) {
      for (const ghost of [true, false]) {
        glyphs(H.lay, H.x, H.y, H.maxW, (g, k, u) => {
          const q = E.outCubic(seg(H.tau, at(u), at(u) + 0.22));
          if (q <= 0 || (ghost && q >= 1)) return null;
          return ghost ? { s: lerp(6, 1.6, q), a: 0.35 * (1 - q), color: H.color(g), stroke: null } : { s: lerp(4, 1, q), a: q * 2, color: H.color(g) };
        });
      }
    },
    // Each line rises out of its own slot.
    rise(H) {
      const c = K.ctx;
      H.lay.lines.forEach((_, li) => {
        const [lx, ly, lw, lh] = lineBox(H.lay, H.x, H.y, H.maxW, li);
        c.save(); c.beginPath(); c.rect(lx - X(30), ly - X(10), lw + X(60), lh + X(14)); c.clip();
        glyphs(H.lay, H.x, H.y, H.maxW, (g, k, u) => {
          if (g.li !== li) return null;
          const q = E.outExpo(seg(H.tau, at(u) - 0.04, at(u) + 0.3));
          return q > 0 ? { dy: (1 - q) * lh, color: H.color(g) } : null;
        });
        c.restore();
      });
    },
    // Typewriter with a blinking block cursor.
    type(H) {
      let last = null;
      glyphs(H.lay, H.x, H.y, H.maxW, (g, k, u) => {
        const since = H.tau - at(u);
        if (since < 0) return null;
        last = g;
        return { s: 1 + 0.35 * Math.exp(-since * 30), color: H.color(g) };
      });
      if (last && (H.tau < at(unitCount(H.lay)) + 0.3 || Math.floor(H.t * 4) % 2 === 0)) {
        const gx = K.lineX(H.lay, last.li, H.x, H.maxW, 'left') + last.x + last.w + X(8);
        K.fill(YELLOW, gx, H.y + last.li * H.lay.lineH + H.lay.size * 0.05, H.lay.size * 0.12, H.lay.size * 0.95);
      }
    },
    // RGB-split glitch that keeps twitching on the kick.
    glitch(H) {
      const c = K.ctx, fr = Math.floor(H.t * 30);
      const jitter = (k, u) => (1 - seg(H.tau, at(u), at(u) + 0.25)) + 0.25 * (kickEnv(H.t, 25) > 0.6 ? 1 : 0);
      [['#ff0050', -1], ['#00f0ff', 1]].forEach(([tint, d]) => {
        c.save(); c.globalCompositeOperation = 'lighter';
        glyphs(H.lay, H.x, H.y, H.maxW, (g, k, u) => {
          if (H.tau < at(u)) return null;
          const j = jitter(k, u);
          return { dx: d * X(5 + 16 * j), dy: (hashN(fr * 3 + k) - 0.5) * X(20) * j, color: tint, stroke: null, a: 0.85 };
        });
        c.restore();
      });
      glyphs(H.lay, H.x, H.y, H.maxW, (g, k, u) => {
        if (H.tau < at(u)) return null;
        const j = jitter(k, u);
        return { dx: (hashN(fr * 7 + k) - 0.5) * X(40) * j, color: H.color(g), ch: j > 0.5 && hashN(fr + k * 13) > 0.6 ? POOL[k % POOL.length] : undefined };
      });
    },
    // Neon tubes flickering on, then humming with the beat.
    neon(H) {
      const c = K.ctx, glow = col(H.i + 3, 64);
      c.save();
      c.shadowColor = glow; c.shadowBlur = X(24) * (1 + 0.6 * kickEnv(H.t));
      glyphs(H.lay, H.x, H.y, H.maxW, (g, k, u) => {
        const since = H.tau - at(u);
        if (since < 0) return null;
        const on = since < 0.3 ? (hashN(Math.floor(H.t * 30) * 5 + k) > 0.45 ? 1 : 0.15) : 1;
        return { a: on, color: H.hl(g) ? YELLOW : '#fff', stroke: glow, sw: 0.1 };
      });
      c.restore();
    },
    // Rises in and keeps riding a wave.
    wave(H) {
      glyphs(H.lay, H.x, H.y, H.maxW, (g, k, u) => {
        const q = E.outBack(seg(H.tau, at(u), at(u) + 0.25), 2);
        if (q <= 0) return null;
        return { dy: (1 - q) * X(90) + Math.sin(H.t * 7 - k * 0.55) * X(9), r: Math.sin(H.t * 7 - k * 0.55) * 0.06, a: q * 3, color: H.color(g) };
      });
    },
    // Lines whip in from alternating sides, trailing speed lines.
    slice(H) {
      H.lay.lines.forEach((_, li) => {
        const q = E.outExpo(seg(H.tau, WORD_START + li * 0.1, WORD_START + li * 0.1 + 0.32)), dir = li % 2 ? 1 : -1;
        if (q <= 0) return;
        const [lx, ly, lw, lh] = lineBox(H.lay, H.x, H.y, H.maxW, li), off = (1 - q) * W * 1.1 * dir;
        if (q < 1) for (let s = 0; s < 5; s++) {
          const sy = ly + lh * (0.15 + 0.17 * s), len = X(400) * (1 - q);
          K.fill(col(H.i + s, 70, 0.8 * (1 - q)), lx + off + (dir < 0 ? lw : -len), sy, len, X(6));
        }
        glyphs(H.lay, H.x, H.y, H.maxW, (g) => (g.li === li ? { dx: off, r: -dir * 0.12 * (1 - q), color: H.color(g) } : null));
      });
    },
    // Slammed down as a colour plate, shaking the heading.
    stamp(H) {
      const c = K.ctx, q = seg(H.tau, 0.05, 0.2), s = lerp(3, 1, E.inCubic(q));
      if (q <= 0) return;
      const shake = q >= 1 ? Math.exp(-(H.tau - 0.2) * 12) * X(14) : 0, fr = Math.floor(H.t * 30);
      const h = H.lay.lines.length * H.lay.lineH, w = Math.max(...H.lay.lines.map((l) => l.w));
      const cx = H.x + w / 2, cy = H.y + h / 2;
      c.save();
      c.translate((hashN(fr) - 0.5) * shake, (hashN(fr + 3) - 0.5) * shake);
      c.translate(cx, cy); c.rotate(-0.05); c.scale(s, s); c.translate(-cx, -cy);
      c.globalAlpha *= clamp(q * 3);
      c.beginPath(); c.roundRect(H.x - X(22), H.y - X(12), w + X(44), h + X(14), X(18));
      c.fillStyle = col(H.i, 50); c.fill(); c.strokeStyle = '#000'; c.lineWidth = X(8); c.stroke();
      glyphs(H.lay, H.x, H.y, H.maxW, (g) => ({ color: H.color(g) }));
      c.restore();
    },
    // Stretches up from the baseline with a jelly wobble.
    elastic(H) {
      glyphs(H.lay, H.x, H.y, H.maxW, (g, k, u) => {
        const q = seg(H.tau, at(u), at(u) + 0.55);
        if (q <= 0) return null;
        const sy = E.outElastic(q), sx = clamp(2 - sy, 0.6, 1.5);
        return { sy, sx, dy: (1 - sy) * H.lay.size / 2, color: H.color(g) };
      });
    },
    // Decoder: random characters rattle before each letter locks in.
    scramble(H) {
      const fr = Math.floor(H.t * 24);
      glyphs(H.lay, H.x, H.y, H.maxW, (g, k, u) => {
        const since = H.tau - at(u) + 0.1;
        if (since < 0) return null;
        const locked = since > 0.22;
        return { ch: locked ? undefined : POOL[Math.floor(hashN(fr * 31 + k) * POOL.length)],
          color: locked ? H.color(g) : col(H.i + k, 70), s: locked ? 1 + 0.25 * Math.exp(-(since - 0.22) * 20) : 1 };
      });
    },
    // Outline first, then the fill sweeps across like paint.
    sweep(H) {
      const c = K.ctx, n = unitCount(H.lay), q = E.inOutCubic(seg(H.tau, WORD_START, at(n) + 0.12));
      const outline = clamp(H.tau * 8), edge = H.x + (H.maxW + X(40)) * q;
      c.save(); c.beginPath(); c.rect(edge, 0, W, K.H); c.clip();
      glyphs(H.lay, H.x, H.y, H.maxW, () => ({ a: outline, fill: false, stroke: col(H.i, 72), sw: 0.06 }));
      c.restore();
      c.save(); c.beginPath(); c.rect(0, 0, edge, K.H); c.clip();
      glyphs(H.lay, H.x, H.y, H.maxW, (g) => ({ color: H.color(g) }));
      c.restore();
    },
    // Chunky 3D extrusion that deepens as each word lands.
    extrude(H) {
      const D = 7;
      const e = (u) => E.outBack(seg(H.tau, at(u), at(u) + 0.2), 2.5);
      for (let d = D; d >= 1; d--) {
        glyphs(H.lay, H.x, H.y, H.maxW, (g, k, u) => {
          const q = e(u);
          return q > 0 ? { s: q, dx: d * X(2.6) * q, dy: d * X(2.6) * q, color: col(H.i, 18 + d * 3), stroke: null } : null;
        });
      }
      glyphs(H.lay, H.x, H.y, H.maxW, (g, k, u) => { const q = e(u); return q > 0 ? { s: q, color: H.color(g), sw: 0.08 } : null; });
    },
    // Pops in, then the colours keep cycling like a rainbow.
    rainbow(H) {
      glyphs(H.lay, H.x, H.y, H.maxW, (g, k, u) => {
        const e = E.outBack(seg(H.tau, at(u), at(u) + 0.16), 3);
        return e > 0 ? { s: e * (1 + 0.08 * Math.sin(H.t * 10 - k)), color: `hsl(${(H.t * 240 + k * 28) % 360} 100% 66%)` } : null;
      });
    },
    // Shards fly in from everywhere and assemble.
    shatter(H) {
      glyphs(H.lay, H.x, H.y, H.maxW, (g, k, u) => {
        const q = E.outCubic(seg(H.tau, at(u) - 0.08, at(u) + 0.24));
        if (q <= 0) return null;
        const a = hashN(seed + k * 7) * TAU, d = X(700) * (1 - q);
        return { dx: Math.cos(a) * d, dy: Math.sin(a) * d, r: (hashN(k * 3 + seed) - 0.5) * 8 * (1 - q), s: lerp(2.5, 1, q), a: q * 3, color: H.color(g) };
      });
    },
    // A highlighter bar swipes under each line before the words pop on top.
    marker(H) {
      const c = K.ctx;
      H.lay.lines.forEach((_, li) => {
        const q = E.outCubic(seg(H.tau, 0.02 + li * 0.08, 0.26 + li * 0.08));
        if (q <= 0) return;
        const [lx, ly, lw, lh] = lineBox(H.lay, H.x, H.y, H.maxW, li);
        c.save(); c.translate(lx, ly + lh * 0.55); c.rotate(-0.02);
        c.fillStyle = col(H.i + li, 55, 0.95); c.fillRect(-X(14), 0, (lw + X(28)) * q, lh * 0.45);
        c.restore();
      });
      glyphs(H.lay, H.x, H.y, H.maxW, (g, k, u) => {
        const e = E.outBack(seg(H.tau, at(u), at(u) + 0.14), 3);
        return e > 0 ? { s: e, dy: (1 - e) * -X(40), color: H.color(g) } : null;
      });
    },
    // Gold letters with a glint that keeps passing through them.
    shine(H) {
      const w = Math.max(...H.lay.lines.map((l) => l.w)), band = ((H.t * 0.9) % 1.4) * (w + X(400)) - X(200);
      glyphs(H.lay, H.x, H.y, H.maxW, (g, k, u) => {
        const e = E.outBack(seg(H.tau, at(u), at(u) + 0.16), 2.5);
        if (e <= 0) return null;
        const gx = K.lineX(H.lay, g.li, 0, H.maxW, 'left') + g.x + g.li * X(40), glint = Math.exp(-(((gx - band) / X(70)) ** 2));
        const base = H.hl(g) ? [255, 225, 0] : [255, 214, 110];
        const mix = base.map((v) => Math.round(lerp(v, 255, glint)));
        return { s: e * (1 + 0.1 * glint), color: `rgb(${mix})`, stroke: '#3a2400' };
      });
    },
    // Fades in soft, then squeezes to a hard beat-pumping shape.
    pump(H) {
      glyphs(H.lay, H.x, H.y, H.maxW, (g, k, u) => {
        const q = seg(H.tau, at(u), at(u) + 0.2);
        if (q <= 0) return null;
        const kick = kickEnv(H.t, 12), sy = 1 + 0.28 * kick * (k % 2 ? 1 : 0.4);
        return { sx: lerp(0.2, 1, E.outBack(q, 2)) / Math.sqrt(sy), sy: lerp(2.2, 1, E.outBack(q, 2)) * sy, dy: -(sy - 1) * H.lay.size * 0.5, a: q * 3, color: H.color(g) };
      });
    },
  };
  const at = (u) => WORD_START + u * WORD_STEP;

  function order() {
    const ids = Object.keys(STYLES);
    for (let k = ids.length - 1; k > 0; k--) {
      const r = Math.floor(hashN(seed * 3 + k * 104729) * (k + 1));
      [ids[k], ids[r]] = [ids[r], ids[k]];
    }
    return ids;
  }

  // hl: [from, to) character range of the keyword, painted yellow.
  function draw(style, lay, x, y, tau, t, i, { hl = null, maxW = W - 2 * x } = {}) {
    const isHl = (g) => !!hl && g.i0 >= hl[0] && g.i0 < hl[1];
    (STYLES[style] ?? STYLES.pop)({ lay, x, y, maxW, tau, t, i, hl: isHl, color: (g) => (isHl(g) ? YELLOW : '#fff') });
  }

  return { STYLES, order, draw };
}
