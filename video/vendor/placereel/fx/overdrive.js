// DOPAMINE OVERDRIVE — graphic layer that hits on every beat, on purpose too much:
// anime focus lines on kicks, light streaks + glitch slices on snares, a HUD frame,
// zoom-smear on every cut/photo swap, a giant outlined keyword drifting across, sparks.
// Everything reads the fixed 120 BPM grid, so the score's zaps/thumps land with it.
import { E, seg, lerp, clamp, TAU, hashN } from '../kit.js';
import { BEAT, CARDS_START, FINALE } from '../timeline.js';
import { kickEnv, snareEnv } from '../energy.js';

const beatNo = (t) => Math.floor(t / BEAT);

function focusLines(K, t) {
  const c = K.ctx, W = K.W, H = K.H, u = K.u;
  const a = kickEnv(t, 9);
  if (a < 0.04) return;
  const b = beatNo(t);
  const cx = W / 2 + (hashN(b) - 0.5) * 160 * u, cy = H * 0.45 + (hashN(b + 5) - 0.5) * 200 * u;
  const R = Math.hypot(W, H);
  c.save();
  c.globalAlpha = 0.42 * a;
  c.fillStyle = '#fff';
  for (let i = 0; i < 64; i++) {
    const ang = hashN(b * 131 + i) * TAU;
    // keep the centre (where the review text sits) clear: lines live near the edges
    const r0 = (0.55 + 0.25 * hashN(b * 7 + i)) * Math.min(W, H) * (1.2 - 0.25 * a);
    const w = (0.004 + 0.01 * hashN(b * 3 + i)) ;
    c.beginPath();
    c.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
    c.lineTo(cx + Math.cos(ang - w) * R, cy + Math.sin(ang - w) * R);
    c.lineTo(cx + Math.cos(ang + w) * R, cy + Math.sin(ang + w) * R);
    c.closePath(); c.fill();
  }
  c.restore();
}

function streaks(K, t) {
  const c = K.ctx, W = K.W, H = K.H, u = K.u, pal = K.pal;
  if (t < BEAT) return;
  const since = (t - BEAT) % (BEAT * 2);
  if (since > 0.28) return;
  const p = E.outCubic(since / 0.28);
  const n = Math.floor((t - BEAT) / (BEAT * 2));
  const dir = n % 2 ? 1 : -1;
  c.save();
  c.globalCompositeOperation = 'lighter';
  c.translate(W / 2, H / 2); c.rotate(dir * 0.5); c.translate(-W / 2, -H / 2);
  for (let k = 0; k < 3; k++) {
    const x = lerp(-W * 0.6, W * 1.6, p) + (k - 1) * 170 * u * dir;
    const w = (60 - k * 18) * u;
    const g = c.createLinearGradient(x - w, 0, x + w, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, k === 1 ? `rgba(255,255,255,${0.7 * (1 - p)})` : pal.hsl(pal.hue + 22, 100, 65, 0.8 * (1 - p)));
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(x - w, -H, w * 2, H * 3);
  }
  c.restore();
}

function glitch(K, t) {
  const c = K.ctx, W = K.W, H = K.H, u = K.u;
  if (t < BEAT) return;
  const since = (t - BEAT) % (BEAT * 2);
  if (since > 0.07) return;
  const n = Math.floor(t * 60);
  for (let i = 0; i < 6; i++) {
    const y = hashN(n * 17 + i) * H, h = (14 + hashN(n * 5 + i) * 70) * u, dx = (hashN(n * 11 + i) - 0.5) * 90 * u;
    c.drawImage(c.canvas, 0, y, W, h, dx, y, W, h);
  }
}

function hud(K, t) {
  const c = K.ctx, W = K.W, H = K.H, u = K.u, pal = K.pal;
  const k = kickEnv(t, 12);
  const m = 34 * u + k * 10 * u;
  const L = 110 * u;
  c.save();
  c.strokeStyle = pal.hsl(pal.hue, 95, 65, 0.85); c.lineWidth = 5 * u;
  [[m, m, 1, 1], [W - m, m, -1, 1], [m, H - m, 1, -1], [W - m, H - m, -1, -1]].forEach(([x, y, sx, sy]) => {
    c.beginPath(); c.moveTo(x, y + sy * L); c.lineTo(x, y); c.lineTo(x + sx * L, y); c.stroke();
  });
  // spinning reticle rings in two corners
  [[W - 120 * u, H * 0.2], [120 * u, H * 0.72]].forEach(([x, y], i) => {
    c.save(); c.translate(x, y); c.rotate(t * (i ? -2 : 2.5));
    c.lineWidth = 3 * u; c.setLineDash([16 * u, 10 * u]);
    c.beginPath(); c.arc(0, 0, (46 + k * 10) * u, 0, TAU); c.stroke();
    c.setLineDash([]);
    c.beginPath(); c.arc(0, 0, 24 * u, 0, TAU * 0.3); c.stroke();
    c.restore();
  });
  // scan line sweeping down each bar
  const sy = ((t % (BEAT * 4)) / (BEAT * 4)) * H;
  const g = c.createLinearGradient(0, sy - 60 * u, 0, sy);
  g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(1, pal.hsl(pal.hue, 100, 70, 0.35));
  c.fillStyle = g; c.fillRect(0, sy - 60 * u, W, 60 * u);
  c.fillStyle = pal.hsl(pal.hue, 100, 80, 0.7); c.fillRect(0, sy, W, 2 * u);
  c.restore();
}

function smear(K, t, marks) {
  const c = K.ctx, W = K.W, H = K.H;
  let d = Infinity;
  for (const m of marks) if (t >= m && t - m < d) d = t - m;
  if (d > 0.14) return;
  const a = 1 - d / 0.14;
  c.save();
  for (const s of [1.04, 1.09]) {
    c.globalAlpha = 0.28 * a;
    c.translate(W / 2, H / 2); c.scale(s, s); c.translate(-W / 2, -H / 2);
    c.drawImage(c.canvas, 0, 0);
  }
  c.restore();
}

function giantWord(K, t) {
  if (t < CARDS_START || t > FINALE) return;
  const c = K.ctx, W = K.W, H = K.H, u = K.u;
  const words = (K.model.keywords || []).slice(0, 3).map((k) => `#${k.word}`);
  if (!words.length) return;
  const str = K.caps('display', words.join('  ')) + '  ';
  K.font('display', 300 * u, { w: 900 });
  const sw = c.measureText(str).width;
  const off = ((t - CARDS_START) * 150 * u) % sw;
  c.save();
  c.globalAlpha = 0.16 + 0.1 * kickEnv(t, 8);
  c.translate(W / 2, H * 0.52); c.rotate(-0.14); c.translate(-W / 2, -H * 0.52);
  c.strokeStyle = '#fff'; c.lineWidth = 3 * u; c.textBaseline = 'middle';
  for (let x = -off - sw; x < W + sw; x += sw) c.strokeText(str, x, H * 0.52);
  c.restore();
  c.letterSpacing = '0px';
}

function sparks(K, t) {
  const c = K.ctx, W = K.W, H = K.H, u = K.u, pal = K.pal;
  const b = beatNo(t), since = t - b * BEAT;
  if (since > 0.3 || b % 2) return;
  const q = since / 0.3;
  const cx = W * (0.25 + 0.5 * hashN(b + 1)), cy = H * (0.3 + 0.4 * hashN(b + 2));
  c.save(); c.globalCompositeOperation = 'lighter'; c.lineCap = 'round';
  for (let i = 0; i < 18; i++) {
    const a = hashN(b * 31 + i) * TAU, v = (380 + 520 * hashN(b * 13 + i)) * u;
    const r1 = v * E.outCubic(q), r0 = Math.max(0, r1 - 80 * u * (1 - q));
    c.strokeStyle = pal.hsl(pal.hue + 30 * hashN(i), 100, 70, 1 - q);
    c.lineWidth = (5 * (1 - q) + 1) * u;
    c.beginPath(); c.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); c.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); c.stroke();
  }
  c.restore();
}

// camera: alternate ±tilt per card, plus a jolt on every kick
export function overdriveTilt(t, amount = 0.035) {
  if (t > FINALE + 0.2) return 0;
  const bar = Math.floor(t / (BEAT * 4));
  const target = (bar % 2 ? 1 : -1) * amount;
  const inBar = (t % (BEAT * 4)) / (BEAT * 4);
  const ease = E.outBack(clamp(inBar * 6), 2);
  return target * ease + (beatNo(t) % 2 ? 1 : -1) * 0.008 * kickEnv(t, 14);
}

export function overdrive(K, t, marks) {
  if (t > FINALE + 0.3) return;
  giantWord(K, t);
  smear(K, t, marks);
  focusLines(K, t);
  streaks(K, t);
  sparks(K, t);
  glitch(K, t);
  hud(K, t);
}
