// TRANSITIONS. draw(K, p, A, B): p∈[0,1] with the cut at p=0.5. A/B paint into K.ctx.
// Snapshot-based ones render A/B into offscreen canvases first.
import { E, seg, lerp, clamp, TAU, hashN } from '../kit.js';

const band = {
  draw(K, p, A, B) {
    const c = K.ctx, W = K.W, H = K.H;
    (p < 0.5 ? A : B)();
    const sk = (K.P ? 0.35 : 0.3) * H;
    const L = (q) => lerp(-sk, W + sk, q);
    const shape = (l, tr, col) => {
      if (l <= tr) return;
      c.beginPath(); c.moveTo(tr, H); c.lineTo(tr + sk, 0); c.lineTo(l + sk, 0); c.lineTo(l, H); c.closePath();
      c.fillStyle = col; c.fill();
    };
    const lead = L(E.inCubic(seg(p, 0, 0.5))), trail = L(E.outExpo(seg(p, 0.5, 1)));
    const lead2 = L(E.inCubic(seg(p, -0.06, 0.46))), trail2 = L(E.outExpo(seg(p, 0.47, 0.9)));
    shape(Math.max(lead, lead2), Math.max(trail, trail2), K.pal.accent2);
    shape(lead, trail, K.pal.accent);
    shape(lead - sk * 0.2, trail + sk * 0.25, K.pal.bg);
  },
};

const iris = {
  draw(K, p, A, B, meta = {}) {
    const c = K.ctx, W = K.W, H = K.H, u = K.u;
    A();
    const [cx, cy] = meta.center || [W / 2, H / 2];
    const q = E.inOutExpo(p);
    const r = q * Math.hypot(W, H);
    c.save(); c.beginPath(); c.arc(cx, cy, r, 0, TAU); c.clip(); B(); c.restore();
    c.strokeStyle = K.pal.accent; c.lineWidth = 12 * u * (1 - q);
    c.beginPath(); c.arc(cx, cy, r, 0, TAU); c.stroke();
  },
};

const zoom = {
  draw(K, p, A, B) {
    const c = K.ctx, W = K.W, H = K.H;
    c.save();
    if (p < 0.5) { const s = 1 + 1.2 * E.inExpo(p * 2); c.translate(W / 2, H / 2); c.scale(s, s); c.translate(-W / 2, -H / 2); A(); }
    else { const s = lerp(0.6, 1, E.outExpo((p - 0.5) * 2)); c.translate(W / 2, H / 2); c.scale(s, s); c.translate(-W / 2, -H / 2); c.fillStyle = '#000'; c.fillRect(-W, -H, W * 3, H * 3); B(); }
    c.restore();
    const fl = 1 - Math.abs(p - 0.5) * 5;
    if (fl > 0) K.fill(`rgba(255,255,255,${fl * 0.8})`);
  },
};

const whip = {
  draw(K, p, A, B) {
    const c = K.ctx, W = K.W, H = K.H, u = K.u;
    const horiz = !K.P;
    const snap = K.snap(0, p < 0.5 ? A : B);
    const off = p < 0.5 ? -E.inExpo(p * 2) : 1 - E.outExpo((p - 0.5) * 2);
    const vel = 1 - Math.abs(p - 0.5) * 2;
    const d = horiz ? W : H;
    const n = 5;
    for (let k = 0; k < n; k++) {
      c.globalAlpha = k === 0 ? 1 : (0.35 * vel) / k;
      const o = off * d + k * vel * 60 * u * Math.sign(off || 1);
      c.drawImage(snap, horiz ? o : 0, horiz ? 0 : o);
      c.drawImage(snap, horiz ? o + (off < 0 ? d : -d) : 0, horiz ? 0 : o + (off < 0 ? d : -d));
    }
    c.globalAlpha = 1;
    c.fillStyle = `rgba(255,255,255,${0.5 * vel})`;
    for (let i = 0; i < 16; i++) {
      const r = hashN(i + 3);
      if (horiz) c.fillRect(((hashN(i) + p * 3) % 1) * W, r * H, W * 0.4 * vel, 2 * u);
      else c.fillRect(r * W, ((hashN(i) + p * 3) % 1) * H, 2 * u, H * 0.4 * vel);
    }
  },
};

const shutter = {
  draw(K, p, A, B) {
    const c = K.ctx, W = K.W, H = K.H;
    (p < 0.5 ? A : B)();
    const N = 8;
    const close = p < 0.5 ? E.inOutCubic(p * 2) : 1 - E.inOutCubic((p - 0.5) * 2);
    for (let i = 0; i < N; i++) {
      const w = W / N;
      const k = clamp(close * 1.25 - (i % 2) * 0.12);
      c.fillStyle = i % 2 ? K.pal.bg2 : K.pal.bg;
      c.fillRect(i * w + (w * (1 - k)) / 2, 0, w * k + 1, H);
    }
    c.fillStyle = K.pal.accent;
    if (close > 0.9) c.fillRect(0, H / 2 - 2 * K.u, W * ((close - 0.9) * 10), 4 * K.u);
  },
};

const ink = {
  draw(K, p, A, B, meta = {}) {
    const c = K.ctx, W = K.W, H = K.H;
    A();
    const [cx, cy] = meta.center || [W * 0.5, H * 0.5];
    const r = E.inOutCubic(p) * Math.hypot(W, H) * 0.75;
    c.save();
    K.blobPath(c, cx, cy, r * 1.04, 3, 0.22, p * 4);
    c.fillStyle = K.pal.accentDeep; c.fill();
    K.blobPath(c, cx, cy, r, 3, 0.22, p * 4);
    c.clip();
    B();
    c.restore();
    for (let i = 0; i < 7; i++) {
      const a = hashN(i) * TAU, d = r * (0.9 + 0.3 * hashN(i + 5));
      c.fillStyle = K.pal.accentDeep;
      c.beginPath(); c.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, r * 0.05 * hashN(i + 9), 0, TAU); c.fill();
    }
  },
};

const pixel = {
  draw(K, p, A, B) {
    const c = K.ctx, W = K.W, H = K.H, u = K.u;
    const snap = K.snap(0, p < 0.5 ? A : B);
    const tri = 1 - Math.abs(p - 0.5) * 2;
    const bs = Math.max(1, Math.round(lerp(1, 72 * u, E.inCubic(tri))));
    if (bs <= 1) { c.drawImage(snap, 0, 0); return; }
    const sw = Math.ceil(W / bs), sh = Math.ceil(H / bs);
    const sc = K.scratch('px', sw, sh);
    const x = sc.getContext('2d');
    x.imageSmoothingEnabled = true;
    x.drawImage(snap, 0, 0, sw, sh);
    c.save();
    c.imageSmoothingEnabled = false;
    c.drawImage(sc, 0, 0, sw * bs, sh * bs);
    c.restore();
  },
};

const burn = {
  draw(K, p, A, B) {
    const c = K.ctx, W = K.W, H = K.H;
    const a = K.snap(0, A), b = K.snap(1, B);
    const mix = E.inOutCubic(seg(p, 0.3, 0.7));
    c.drawImage(a, 0, 0);
    c.globalAlpha = mix; c.drawImage(b, 0, 0); c.globalAlpha = 1;
    const tri = 1 - Math.abs(p - 0.5) * 2;
    c.save();
    c.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 3; i++) {
      const x = W * (0.2 + 0.6 * hashN(i + 1)) + (p - 0.5) * W * 0.6 * (i % 2 ? 1 : -1);
      const y = H * (0.3 + 0.4 * hashN(i + 7));
      c.fillStyle = K.radial(x, y, Math.max(W, H) * (0.3 + 0.3 * tri), `rgba(255,${120 + i * 40},40,${0.9 * tri})`);
      c.fillRect(0, 0, W, H);
    }
    c.restore();
    if (tri > 0.8) K.fill(`rgba(255,240,220,${(tri - 0.8) * 4})`);
  },
};

const doors = {
  draw(K, p, A, B) {
    const c = K.ctx, W = K.W, H = K.H, u = K.u;
    if (p < 0.35) { A(); const q = seg(p, 0.15, 0.35); c.fillStyle = K.pal.accent; if (!K.P) c.fillRect(W / 2 - u * 2, H * (1 - q) / 2, 4 * u, H * q); else c.fillRect(W * (1 - q) / 2, H / 2 - 2 * u, W * q, 4 * u); return; }
    const a = K.snap(0, A);
    c.save();
    const s = lerp(1.12, 1, E.outCubic(seg(p, 0.35, 1)));
    c.translate(W / 2, H / 2); c.scale(s, s); c.translate(-W / 2, -H / 2);
    B();
    c.restore();
    const q = E.inOutCubic(seg(p, 0.35, 0.95));
    c.save();
    c.shadowColor = 'rgba(0,0,0,.6)'; c.shadowBlur = 50 * u;
    if (!K.P) {
      const d = q * W / 2;
      c.drawImage(a, 0, 0, W / 2, H, -d, 0, W / 2, H);
      c.drawImage(a, W / 2, 0, W / 2, H, W / 2 + d, 0, W / 2, H);
    } else {
      const d = q * H / 2;
      c.drawImage(a, 0, 0, W, H / 2, 0, -d, W, H / 2);
      c.drawImage(a, 0, H / 2, W, H / 2, 0, H / 2 + d, W, H / 2);
    }
    c.restore();
  },
};

const tiles = {
  draw(K, p, A, B) {
    const c = K.ctx, W = K.W, H = K.H;
    const a = K.snap(0, A), b = K.snap(1, B);
    const cols = K.P ? 5 : 8, rows = K.P ? 9 : 5;
    const tw = W / cols, th = H / rows;
    K.fill(K.pal.bg);
    for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) {
      const d = (q + r) / (cols + rows - 2);
      const f = seg(p, d * 0.55, d * 0.55 + 0.45);
      const ang = f * Math.PI;
      const sx = Math.abs(Math.cos(ang));
      const src = ang < Math.PI / 2 ? a : b;
      const x = q * tw, y = r * th;
      c.save();
      c.translate(x + tw / 2, y + th / 2);
      c.scale(Math.max(0.001, sx), 1);
      c.drawImage(src, x, y, tw, th, -tw / 2, -th / 2, tw + 1, th + 1);
      if (sx < 0.95) { c.fillStyle = `rgba(0,0,0,${0.5 * (1 - sx)})`; c.fillRect(-tw / 2, -th / 2, tw, th); }
      c.restore();
    }
  },
};

const swipe = {
  draw(K, p, A, B) {
    const c = K.ctx, W = K.W, H = K.H, u = K.u;
    const q = E.inOutCubic(p);
    const a = K.snap(0, A), b = K.snap(1, B);
    // outgoing card lifts and shrinks slightly, incoming rides up from below
    c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
    c.save();
    const s = 1 - 0.08 * q;
    c.translate(W / 2, H / 2 - q * H * 0.92); c.scale(s, s); c.translate(-W / 2, -H / 2);
    c.globalAlpha = 1 - 0.5 * q;
    c.beginPath(); c.roundRect(0, 0, W, H, 40 * u * q); c.clip();
    c.drawImage(a, 0, 0);
    c.restore();
    c.save();
    c.translate(0, (1 - q) * H);
    c.shadowColor = 'rgba(0,0,0,.6)'; c.shadowBlur = 60 * u;
    c.beginPath(); c.roundRect(0, 0, W, H, 40 * u * (1 - q)); c.fillStyle = '#000'; c.fill();
    c.shadowColor = 'transparent'; c.clip();
    c.drawImage(b, 0, 0);
    c.restore();
  },
};

const flash = {
  draw(K, p, A, B) {
    const c = K.ctx, W = K.W, H = K.H;
    c.save();
    if (p < 0.5) { const s = 1 + 0.15 * E.inCubic(p * 2); c.translate(W / 2, H / 2); c.scale(s, s); c.translate(-W / 2, -H / 2); A(); }
    else { const s = lerp(1.12, 1, E.outExpo((p - 0.5) * 2)); c.translate(W / 2, H / 2); c.scale(s, s); c.translate(-W / 2, -H / 2); B(); }
    c.restore();
    const f = Math.max(0, 1 - Math.abs(p - 0.5) * 6);
    if (f > 0) K.fill(`rgba(255,255,255,${f})`);
  },
};

export const TRANSITION = { band, iris, zoom, whip, shutter, ink, pixel, burn, doors, tiles, swipe, flash };
