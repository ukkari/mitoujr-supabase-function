// Voiceover: every review read aloud by a different voice, locked to the beat.
//  1. plan: which text each review card reads, in which window, with which voice
//  2. fit:  trim silence, then time-stretch (≤1.45×; longer reads are re-recorded shorter) (pitch preserved) so each read starts on the
//           card's downbeat and ends on an 8th-note grid point inside its window
//  3. the renderer paces the captions to the read, the score ducks the music under it

import { BEAT } from './timeline.js';

// a spread of distinct prebuilt Gemini voices (mixed timbres)
export const VOICES = ['Puck', 'Kore', 'Charon', 'Zephyr', 'Fenrir', 'Leda', 'Aoede', 'Orus', 'Achird', 'Sulafat', 'Autonoe', 'Iapetus', 'Laomedeia', 'Sadachbia', 'Algieba', 'Despina', 'Umbriel', 'Erinome', 'Gacrux', 'Rasalgethi'];

const STYLE = {
  chill: 'warm, natural and brisk, like a friend recommending a place; no pauses',
  hype: 'fast, upbeat short-video voiceover; energetic; no pauses',
  dopamine: 'very fast and hyped, excited TikTok voiceover; punchy; no pauses',
};

// Measured on Gemini TTS with the "fast" styles: a read takes ~0.45s + 0.245s per word.
const READ_BASE = 0.45, READ_PER_WORD = 0.245;
export const estRead = (words) => READ_BASE + READ_PER_WORD * words;
const FIT_RATE = { chill: 1.15, hype: 1.3, dopamine: 1.4 }; // speed-up we plan text for
const MAX_RATE = 1.45; // hard ceiling: faster than this sounds garbled, so the text gets shorter instead
const MIN_RATE = 0.95;
const LEAD = 0.06;     // start just after the downbeat so the cut lands first
const GRID = BEAT / 2; // reads end on 8th notes
export const VOICE_GAP = 0.14; // silence between one read and the next

// how many words can be read in `secs` at this energy's planned speed-up
export const fitWords = (secs, energy = 'hype') => Math.max(3, Math.floor(((FIT_RATE[energy] || 1.3) * secs - READ_BASE) / READ_PER_WORD));

const JOIN = /^(and|but|so|because|if|when|which|that|who|while|although|though|or|plus|then|as|with|from|for|in|at|on|during|after|before|since|until|to)$/i;
const DANGLING = /^(and|or|but|so|if|because|the|a|an|to|of|for|with|in|on|at|was|is|are|were|it|its|it’s|it's|my|our|their|that|which|very|really|just|as|by|from)$/i;

// Shorten a review to at most `max` words, ending on a clause (never on "and", "if", …).
export function trimWords(text, max) {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  if (words.length <= max) return text.trim();
  const floor = Math.max(3, Math.ceil(max * 0.55));
  let cut = max;
  // best: end of a clause (punctuation); next: just before a joining word; else the budget
  let found = false;
  for (let i = max; i >= floor && !found; i--) if (/[,;:.!?]$/.test(words[i - 1])) { cut = i; found = true; }
  for (let i = max; i >= 3 && !found; i--) if (JOIN.test(words[i])) { cut = i; found = true; }
  // don't leave a 1–2 word fragment after another joining word ("… stay from start")
  if (found) for (let j = cut - 1; j >= Math.max(3, cut - 2); j--) if (JOIN.test(words[j])) cut = j;
  let out = words.slice(0, cut);
  while (out.length > 3 && DANGLING.test(out[out.length - 1].replace(/[,;:.!?"”]+$/, ''))) out.pop();
  return out.join(' ').replace(/[,;:]+$/, '');
}
export const fitText = (text, secs, energy) => trimWords(text, fitWords(secs, energy));

// One clip per review: card k, review j (multi cards have several reviews).
export function planVoice(cards, seed = 1, energy = 'hype') {
  let s = seed >>> 0 || 1;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const voices = [...VOICES].sort(() => rnd() - 0.5);
  const clips = [];
  let v = 0;
  cards.forEach((c, k) => {
    const reviews = c.kind === 'multi' ? c.qs.map((q, j) => ({ q, from: c.starts[j], to: j + 1 < c.qs.length ? c.starts[j + 1] : c.b - c.a }))
      : c.kind === 'quote' ? [{ q: c.q, from: 0, to: c.b - c.a }] : [];
    reviews.forEach(({ q, from, to }, j) => {
      const start = c.a + from + LEAD;
      const window = Math.max(0.5, to - from - LEAD - VOICE_GAP);
      clips.push({ key: `${k}:${j}`, card: k, review: j, start, window, text: fitText(q.text, window, energy), voice: voices[v++ % voices.length], style: STYLE[energy] || STYLE.hype });
    });
  });
  return clips;
}

// ---- audio fitting -------------------------------------------------------------

function trimSilence(x, sr, thresh = 0.02) {
  let a = 0, b = x.length - 1;
  while (a < b && Math.abs(x[a]) < thresh) a++;
  while (b > a && Math.abs(x[b]) < thresh) b--;
  a = Math.max(0, a - Math.round(0.01 * sr)); // keep 10ms of attack
  b = Math.min(x.length - 1, b + Math.round(0.04 * sr));
  return x.subarray(a, b + 1);
}

// WSOLA time-stretch: rate > 1 = faster, pitch unchanged.
export function timeStretch(x, rate, sr) {
  if (Math.abs(rate - 1) < 0.01) return Float32Array.from(x);
  const N = Math.round(0.03 * sr), Hs = N >> 1, Ha = Math.round(Hs * rate), tol = Math.round(0.008 * sr);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const frames = Math.max(1, Math.floor((x.length - N - tol) / Ha));
  const out = new Float32Array(frames * Hs + N);
  const norm = new Float32Array(out.length);
  let prev = 0; // analysis position of the previous frame
  for (let m = 0; m < frames; m++) {
    const nominal = m * Ha;
    let best = nominal;
    if (m > 0) {
      // pick the offset whose frame best continues the previous one (cross-correlation)
      const ref = prev + Hs;
      let bestC = -Infinity;
      for (let d = -tol; d <= tol; d += 2) {
        const p = nominal + d;
        if (p < 0 || p + N >= x.length || ref + N >= x.length) continue;
        let c = 0;
        for (let i = 0; i < N; i += 3) c += x[p + i] * x[ref + i];
        if (c > bestC) { bestC = c; best = p; }
      }
    }
    const o = m * Hs;
    for (let i = 0; i < N && best + i < x.length; i++) { out[o + i] += x[best + i] * win[i]; norm[o + i] += win[i]; }
    prev = best;
  }
  for (let i = 0; i < out.length; i++) if (norm[i] > 1e-3) out[i] /= norm[i];
  return out;
}

// Last resort for a read that is still too long: cut it at the last pause (never mid-word)
// that fits at MAX_RATE. Returns the sample index to cut at, or -1.
function lastPauseBefore(x, sr, limit) {
  const hop = Math.round(0.01 * sr), need = 5; // 50ms of quiet
  let quiet = 0, best = -1;
  for (let i = 0; i + hop <= Math.min(x.length, limit); i += hop) {
    let e = 0;
    for (let k = i; k < i + hop; k++) e += x[k] * x[k];
    if (Math.sqrt(e / hop) < 0.012) { if (++quiet >= need) best = i - (need - 1) * hop; } else quiet = 0;
  }
  return best > 0.4 * sr ? best : -1;
}

// Decode + fit every clip. Returns [{...clip, buffer, dur, words}] (AudioBuffers at 48kHz).
// Reads that would need more than MAX_RATE are listed in `.retry` ({...clip, text: shorter})
// unless `final`, in which case they are cut at their last pause instead.
export async function prepareVoice(clips, audioByKey, energy = 'hype', { final = false } = {}) {
  const ctx = new OfflineAudioContext(1, 48000, 48000);
  const prefer = { chill: 1.0, hype: 1.12, dopamine: 1.25 }[energy] || 1.12; // how much faster than natural
  const out = [];
  out.retry = [];
  for (const c0 of clips) {
    let c = c0;
    const b64 = audioByKey[c.key];
    if (!b64) continue;
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    let decoded;
    try { decoded = await ctx.decodeAudioData(bytes.buffer); } catch { continue; }
    const sr = decoded.sampleRate;
    let raw = trimSilence(decoded.getChannelData(0), sr);
    let natural = raw.length / sr;
    if (natural / c.window > MAX_RATE) {
      const words = c.text.split(/\s+/).filter(Boolean).length;
      if (!final && words > 3) {
        // ask for a shorter read: scale the words to what fits, with a little margin
        const keep = Math.max(3, Math.min(words - 1, Math.floor(words * ((c.window * (FIT_RATE[energy] || 1.3)) / natural) * 0.95)));
        out.retry.push({ ...c, text: trimWords(c.text, keep) });
        continue;
      }
      const cut = lastPauseBefore(raw, sr, Math.floor(c.window * MAX_RATE * sr));
      if (cut > 0) {
        const frac = cut / raw.length;
        raw = trimSilence(raw.subarray(0, cut), sr);
        natural = raw.length / sr;
        c = { ...c, text: trimWords(c.text, Math.max(2, Math.round(words * frac))) };
      }
    }
    // the read ENDS on an 8th note: pick the grid point inside the window closest to a
    // comfortably-fast read, within the stretch limits
    const lo = c.start + natural / MAX_RATE, hi = c.start + Math.min(c.window, natural / MIN_RATE);
    const want = c.start + natural / prefer;
    let end = Math.round(want / GRID) * GRID;
    if (end > hi) end = Math.floor(hi / GRID) * GRID;
    if (end < lo) end = Math.ceil(lo / GRID) * GRID;
    if (end > c.start + c.window + 1e-6) end = c.start + c.window; // can't fit on the grid: use the whole window
    const target = end - c.start;
    const rate = natural / target;
    let y = timeStretch(raw, rate, sr);
    // exact length so the last syllable lands on the grid point (pad, or fade the last few ms)
    const want2 = Math.round(target * sr);
    if (y.length > want2) {
      y = y.subarray(0, want2);
      const f = Math.min(Math.round(0.015 * sr), want2);
      for (let i = 0; i < f; i++) y[want2 - f + i] *= 1 - i / f;
    } else if (y.length < want2) {
      const z = new Float32Array(want2); z.set(y); y = z;
    }
    const buf = ctx.createBuffer(1, y.length, sr);
    buf.copyToChannel(y, 0);
    out.push({ ...c, buffer: buf, dur: y.length / sr, rate, words: c.text.split(/\s+/).filter(Boolean).length });
  }
  return out;
}

// caption pacing for the renderer: per card/review, where the read starts and how fast words come
export function voiceTiming(prepared, cards) {
  const map = {};
  for (const p of prepared) {
    const c = cards[p.card];
    map[p.key] = { start: p.start - c.a, step: p.dur / Math.max(1, p.words), words: p.words, dur: p.dur, text: p.text };
  }
  return map;
}
