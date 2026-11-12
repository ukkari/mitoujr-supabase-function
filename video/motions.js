// Motion presets on top of PlaceReel's engine: cuts, sticker and topic-emoji entrances. Neighbouring
// scenes pick different ones. Each still lands on its cue (the sound design is unchanged) and settles
// within ~0.45 s. Posts and headings have their own catalogues (post-styles.js, heading-styles.js).
import { E, seg, clamp, TAU } from './vendor/placereel/kit.js';

// ---------- cuts: draw(K, p, A, B) like PlaceReel's transitions (p∈[0,1], cut at p=0.5)
const spin = {
  draw(K, p, A, B) {
    const c = K.ctx, { W, H } = K, out = p < 0.5;
    const q = out ? E.inExpo(p * 2) : 1 - E.outExpo((p - 0.5) * 2);
    c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
    c.save();
    c.translate(W / 2, H / 2); c.rotate((out ? 1 : -1) * q * 1.1); c.scale(1 + 1.3 * q, 1 + 1.3 * q); c.translate(-W / 2, -H / 2);
    (out ? A : B)();
    c.restore();
    const fl = 1 - Math.abs(p - 0.5) * 5;
    if (fl > 0) K.fill(`rgba(255,255,255,${fl * 0.7})`);
  },
};

const push = {
  draw(K, p, A, B) {
    const c = K.ctx, { W, H, u } = K, q = E.inOutExpo(p);
    const a = K.snap(0, A), b = K.snap(1, B);
    c.drawImage(a, -q * W, 0);
    c.drawImage(b, (1 - q) * W, 0);
    c.fillStyle = K.pal.accent; c.fillRect((1 - q) * W - 7 * u, 0, 14 * u, H);
  },
};

const slices = {
  draw(K, p, A, B) {
    const c = K.ctx, { W, H } = K, n = 9;
    const a = K.snap(0, A), b = K.snap(1, B);
    c.drawImage(b, 0, 0);
    for (let i = 0; i < n; i++) {
      const q = E.inOutCubic(seg(p, i * 0.05, 0.6 + i * 0.05));
      if (q >= 1) continue;
      const y = Math.round(i * H / n), h = Math.round((i + 1) * H / n) - y;
      c.drawImage(a, 0, y, W, h, (i % 2 ? 1 : -1) * q * W, y, W, h);
    }
  },
};

const clock = {
  draw(K, p, A, B) {
    const c = K.ctx, { W, H, u } = K, q = E.inOutCubic(p), R = Math.hypot(W, H);
    A();
    if (q <= 0) return;
    const from = -Math.PI / 2, to = from + q * TAU;
    c.save();
    c.beginPath(); c.moveTo(W / 2, H / 2); c.arc(W / 2, H / 2, R, from, to); c.closePath(); c.clip();
    B();
    c.restore();
    if (q < 1) {
      c.strokeStyle = K.pal.accent; c.lineWidth = 14 * u;
      c.beginPath(); c.moveTo(W / 2, H / 2); c.lineTo(W / 2 + Math.cos(to) * R, H / 2 + Math.sin(to) * R); c.stroke();
    }
  },
};

// Old-TV power cycle: the picture collapses to a white line, the next one opens from it.
const squash = {
  draw(K, p, A, B) {
    const c = K.ctx, { W, H } = K, out = p < 0.5;
    const q = out ? E.inCubic(p * 2) : 1 - E.outCubic((p - 0.5) * 2);
    const snap = K.snap(0, out ? A : B), sy = Math.max(0.012, 1 - q);
    c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
    c.save();
    c.translate(W / 2, H / 2); c.scale(1 + 0.12 * q, sy); c.drawImage(snap, -W / 2, -H / 2);
    c.restore();
    c.fillStyle = `rgba(255,255,255,${q * q})`; c.fillRect(0, (H - H * sy) / 2, W, H * sy);
  },
};

const drop = {
  draw(K, p, A, B) {
    const c = K.ctx, { H, u } = K;
    const a = K.snap(0, A), b = K.snap(1, B);
    c.drawImage(a, 0, 0);
    K.fill(`rgba(0,0,0,${0.6 * clamp(p * 2)})`);
    c.save();
    c.shadowColor = 'rgba(0,0,0,.7)'; c.shadowBlur = 60 * u;
    c.drawImage(b, 0, (E.outBounce(p) - 1) * H);
    c.restore();
  },
};

export const CUT = { spin, push, slices, clock, squash, drop };
// Every cut gets a different transition (PlaceReel's twelve plus the six above), alternating families.
export const CUTS = ['band', 'spin', 'zoom', 'slices', 'pixel', 'push', 'whip', 'clock', 'iris',
  'drop', 'flash', 'ink', 'tiles', 'squash', 'swipe', 'doors', 'shutter', 'burn'];

// ---------- stickers: (seconds since the cue, side = ±1 for the screen edge it sits on) → pose
export const STICKER_IN = [
  (since) => ({ scale: E.outBack(seg(since, 0, 0.2), 3) }),                                                 // pop
  (since, side) => { const e = E.outCubic(seg(since, 0, 0.3)); return { dx: side * (1 - e) * 0.35, rot: side * (1 - e) * 5 }; }, // roll in
  (since) => ({ dy: (E.outBounce(seg(since, 0, 0.45)) - 1) * 1.1 }),                                        // drop
];

// ---------- giant topic emoji: seconds into the scene → pose at screen centre, before it parks
export const HERO_IN = [
  (tau) => { const e = E.outBack(seg(tau, 0, 0.2), 2.4); return { scale: e, rot: -0.5 * (1 - e) }; },       // smash
  (tau) => { const e = E.outCubic(seg(tau, 0, 0.26)); return { scale: e, rot: (e - 1) * TAU }; },           // spin in
  (tau) => ({ dy: (E.outBounce(seg(tau, 0, 0.3)) - 1) * 0.75 }),                                            // drop
];
