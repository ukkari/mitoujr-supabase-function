// Energy levels: how hard the edit hits the beat. Chosen by the user, applied on top of
// whatever the director cast. Everything is derived from the fixed 120 BPM grid so
// picture and sound stay locked.

import { BEAT, CARDS_START, FINALE } from './timeline.js';

export const ENERGY = {
  chill: {
    label: 'Chill', hint: 'Smooth, lets the photos breathe',
    punch: 0, snarePulse: 0, photosPerCard: 2, wordPop: false, stickers: false, starTicks: false,
    hookSlam: false, freeze: false, rgb: false, confetti: false, sfx: 0, hats16: false, cutBoom: false,
  },
  hype: {
    label: 'Hype', hint: 'Beat punches and pop-in captions',
    punch: 0.035, snarePulse: 0.05, photosPerCard: 2, wordPop: true, stickers: false, starTicks: true,
    hookSlam: true, freeze: false, rgb: false, confetti: false, sfx: 0.7, hats16: true, cutBoom: false,
  },
  dopamine: {
    label: 'Dopamine', hint: 'Every beat hits: cuts, stickers, booms',
    punch: 0.06, snarePulse: 0.1, photosPerCard: 4, wordPop: true, stickers: true, starTicks: true,
    hookSlam: true, freeze: true, rgb: true, confetti: true, sfx: 1, hats16: true, cutBoom: true, overdrive: true, tilt: 0.035,
  },
};
export const ENERGY_IDS = Object.keys(ENERGY);
export const energyOf = (id) => ENERGY[id] || ENERGY.hype;

// beat envelopes (0 before the first hit)
const since = (t, every, offset = 0) => (t < offset ? Infinity : (t - offset) % every);
export const kickEnv = (t, decay = 14) => Math.exp(-since(t, BEAT) * decay);
export const snareEnv = (t, decay = 10) => Math.exp(-since(t, BEAT * 2, BEAT) * decay); // beats 2 & 4

// word-pop grid: words land on 16th notes starting just after the card cut
export const WORD_START = 0.2;
export const WORD_STEP = BEAT / 4;

// the card that gets a freeze-frame + boom (dopamine), and when inside it
export const FREEZE_CARD = 3;
export const FREEZE_AT = 1.25;
export const FREEZE_LEN = 0.5;

// sticker pops per card (seconds after the card cut)
export const STICKER_TIMES = [0.5, 1.5];

// emoji that suit the place
export function stickerSet(place, keywords = []) {
  const t = `${place.category} ${(place.categories || []).join(' ')} ${keywords.map((k) => k.word).join(' ')}`.toLowerCase();
  if (/ramen|noodle|udon|soba|pho/.test(t)) return ['🍜', '🔥', '😋', '🤤', '💯'];
  if (/sushi|seafood|fish/.test(t)) return ['🍣', '🐟', '😋', '✨', '💯'];
  if (/tempura|fried|karaage|tonkatsu/.test(t)) return ['🍤', '🔥', '😋', '🤤', '💯'];
  if (/coffee|cafe|espresso|latte/.test(t)) return ['☕', '✨', '🥐', '😍', '💯'];
  if (/bakery|pastry|dessert|cake|sweet|parfait/.test(t)) return ['🍰', '😍', '✨', '🤤', '💯'];
  if (/burger|pizza|taco|bbq|steak|grill/.test(t)) return ['🍔', '🔥', '🤤', '😋', '💯'];
  if (/bar|pub|cocktail|izakaya|beer|wine/.test(t)) return ['🍻', '🔥', '🎉', '😎', '💯'];
  if (/hotel|resort|inn|ryokan|spa/.test(t)) return ['✨', '🛎️', '🌃', '😍', '💯'];
  if (/park|garden|temple|shrine|museum/.test(t)) return ['📸', '✨', '🌸', '😍', '💯'];
  return ['🔥', '✨', '😍', '💯', '👏'];
}

// Every sound-effect moment the picture creates, so the score can hit them exactly.
export function sfxEvents(model, energyId, cards, freezeCard = FREEZE_CARD) {
  const en = energyOf(energyId);
  const ev = { pops: [], ticks: [], stickers: [], booms: [], scratch: [], freeze: [], swells: [], zaps: [] };
  if (!en.sfx) return ev;
  if (en.starTicks) for (let i = 0; i < 5; i++) ev.ticks.push(0.25 + i * BEAT / 2);
  if (en.wordPop) {
    for (const c of cards) {
      if ((c.kind !== 'quote' && c.kind !== 'multi') || c.styleId === 'typed') continue; // typed types characters, no word pops
      if (c.qs) { // multi-review card: each review pops from its own start (or its voice read)
        c.qs.forEach((q, j) => {
          const n = q.text.split(/\s+/).filter(Boolean).length;
          const end = j + 1 < c.qs.length ? c.a + c.starts[j + 1] : c.b - 0.2;
          const s0 = c.vstart?.[j] ?? c.starts[j], st = c.steps?.[j] || WORD_STEP;
          for (let i = 0; i < n; i++) { const t = c.a + s0 + i * st; if (t > end) break; ev.pops.push(t); }
        });
        continue;
      }
      const words = c.q.text.split(/\s+/).filter(Boolean).length;
      const times = c.voiceT ? Array.from({ length: words }, (_, i) => c.voiceT.start + i * c.voiceT.step)
        : c.styleId === 'karaoke' ? captionTimes(words, c.b - c.a) : Array.from({ length: words }, (_, i) => WORD_START + i * WORD_STEP);
      for (const dt of times) { const t = c.a + dt; if (t > c.b - 0.15) break; ev.pops.push(t); }
    }
  }
  if (en.stickers) for (const c of cards) for (const s of STICKER_TIMES) ev.stickers.push(c.a + s);
  if (en.freeze && cards[freezeCard]) ev.freeze.push(cards[freezeCard].a + FREEZE_AT);
  if (en.cutBoom) for (const c of cards.slice(1)) ev.booms.push(c.a);
  if (en.rgb) ev.scratch.push(0);
  if (en.cutBoom) ev.swells.push([FINALE - 0.9, FINALE]);
  if (en.overdrive) for (let t = BEAT; t < FINALE; t += BEAT * 2) ev.zaps.push(t); // light streak on every snare
  ev.cardsStart = CARDS_START;
  ev.voiced = cards.some((c) => c.voiceT || c.vstart);
  return ev;
}

// Auto-caption timing: 3-word chunks spread across the card so each chunk stays ~0.5–0.7s
// (readable), words inside a chunk land on 16th notes. Shared by picture and score.
export function captionTimes(words, dur, start = WORD_START) {
  const chunks = Math.max(1, Math.ceil(words / 3));
  const chunkDur = Math.max(0.5, Math.floor(((dur - start - 0.15) / chunks) / 0.125) * 0.125);
  return Array.from({ length: words }, (_, i) => start + Math.floor(i / 3) * chunkDur + (i % 3) * WORD_STEP);
}
