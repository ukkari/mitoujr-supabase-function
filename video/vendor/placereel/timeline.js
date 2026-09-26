// Shared clock for picture + sound. Vertical 9:16 at 120 BPM (beat = 0.5s, bar = 2s).
// Reviews and photos get the screen time: name/rating live in top/bottom telops.
// Length is selectable (10/15/20/30/60s): hook 2s → N two-second review cards → end card
// (2s, or 3s when the length is odd). Exports are live bindings: call setDuration() before
// building a renderer/score and every module sees the new schedule.
export const LENGTHS = [10, 15, 20, 30, 60];
export const BPM = 120;
export const BEAT = 60 / BPM;
export const W = 1080;
export const H = 1920;
export const CARD_LEN = 2;             // one bar per review card
export const CARDS_START = 2;
export const PHOTO_SWAP = 1;           // second photo lands on beat 3 of each card
export const MONTAGE_STEP = BEAT / 4;  // 16ths (kept for effects that stagger on the grid)

export let DURATION, CARD_COUNT, FINALE, QUOTE_CUTS, SCENES, HITS;

export function setDuration(sec = 20) {
  DURATION = LENGTHS.includes(+sec) ? +sec : 20;
  CARD_COUNT = Math.floor((DURATION - CARDS_START - 2) / CARD_LEN); // 10s → 3, 20s → 8, 60s → 28
  FINALE = CARDS_START + CARD_COUNT * CARD_LEN;
  // card boundaries: [2, 4, …, FINALE]
  QUOTE_CUTS = Array.from({ length: CARD_COUNT + 1 }, (_, i) => CARDS_START + i * CARD_LEN);
  // chapters (drive the top band's progress/label)
  SCENES = [
    { id: 'hook', label: 'The spot', start: 0, end: CARDS_START },
    ...QUOTE_CUTS.slice(0, -1).map((t, i) => ({ id: `card${i}`, label: `Review ${i + 1}/${CARD_COUNT}`, start: t, end: t + CARD_LEN })),
    { id: 'outro', label: 'Go', start: FINALE, end: DURATION },
  ];
  // accent hits — flash, shake, light-leak, and a sound-design impact each
  HITS = [
    { t: 0, amp: 0.7 },
    { t: CARDS_START, amp: 0.6 },
    ...QUOTE_CUTS.slice(1, -1).map((t) => ({ t, amp: 0.28 })),
    { t: FINALE, amp: 1 },
  ];
  return DURATION;
}
setDuration(20);

// reviews to fetch so a length has enough quotes (multi cards read 2–4 at once)
export const reviewsFor = (sec) => (sec >= 60 ? 150 : sec >= 30 ? 90 : 60);
