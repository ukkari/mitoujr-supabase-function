// Procedural score (10–60s), synthesised offline and locked to the picture's cut list.
// Seven styles share one instrument kit; all obey the same 120 BPM grid.

import { DURATION, BEAT, HITS, MONTAGE_STEP, QUOTE_CUTS, CARDS_START, FINALE } from './timeline.js';

const SR = 48000;
const BAR = BEAT * 4;
const mtof = (m) => 440 * 2 ** ((m - 69) / 12);

function noiseBuffer(ctx, seconds = 2) {
  const b = ctx.createBuffer(1, SR * seconds, SR);
  const d = b.getChannelData(0);
  let s = 12345;
  for (let i = 0; i < d.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; d[i] = (s / 0x7fffffff) * 2 - 1; }
  return b;
}
function impulse(ctx, seconds, decay) {
  const len = SR * seconds;
  const b = ctx.createBuffer(2, len, SR);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    let s = 777 + c * 991;
    for (let i = 0; i < len; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; d[i] = ((s / 0x7fffffff) * 2 - 1) * (1 - i / len) ** decay; }
  }
  return b;
}

// ---------------------------------------------------------------- harmony
const MINOR = { i: [0, 3, 7, 10, 14], VI: [-4, 0, 3, 7, 11], III: [3, 7, 10, 14, 17], VII: [-2, 2, 5, 9, 14], iv: [5, 8, 12, 15, 19] };
const MAJOR = { I: [0, 4, 7, 11, 14], ii: [2, 5, 9, 12, 16], V: [7, 11, 14, 17, 21], vi: [-3, 0, 4, 7, 11], IV: [-7, -3, 0, 4, 9], iii: [4, 7, 11, 14, 18] };
// several progressions per family; the place's seed picks one, so two places in the
// same style still get different songs
const PROGS = {
  minor: [MINOR, [
    ['i', 'VI', 'III', 'VII', 'i', 'VI', 'III', 'VII', 'iv', 'i'],
    ['i', 'iv', 'VI', 'VII', 'i', 'iv', 'VI', 'VII', 'VI', 'i'],
    ['VI', 'VII', 'i', 'i', 'VI', 'VII', 'III', 'i', 'VII', 'i'],
  ]],
  pop: [MAJOR, [
    ['I', 'V', 'vi', 'IV', 'I', 'V', 'vi', 'IV', 'V', 'I'],
    ['vi', 'IV', 'I', 'V', 'vi', 'IV', 'I', 'V', 'IV', 'I'],
    ['I', 'vi', 'IV', 'V', 'I', 'vi', 'IV', 'V', 'IV', 'I'],
  ]],
  jazz: [MAJOR, [
    ['ii', 'V', 'I', 'vi', 'ii', 'V', 'I', 'vi', 'V', 'I'],
    ['I', 'vi', 'ii', 'V', 'iii', 'vi', 'ii', 'V', 'V', 'I'],
    ['IV', 'iii', 'vi', 'ii', 'IV', 'iii', 'ii', 'V', 'V', 'I'],
  ]],
  float: [MAJOR, [
    ['I', 'IV', 'I', 'vi', 'IV', 'I', 'IV', 'vi', 'IV', 'I'],
    ['IV', 'V', 'iii', 'vi', 'IV', 'V', 'I', 'I', 'IV', 'I'],
  ]],
};

export async function renderSoundtrack(model, style = 'house', { energy = null, events = null, speech = null } = {}) {
  const ctx = new OfflineAudioContext(2, Math.ceil(DURATION * SR), SR);
  const noise = noiseBuffer(ctx);

  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, 0);
  master.gain.exponentialRampToValueAtTime(0.85, 0.02);
  master.gain.setValueAtTime(0.85, DURATION - 0.8);
  master.gain.linearRampToValueAtTime(0, DURATION);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18; comp.ratio.value = 6; comp.attack.value = 0.004; comp.release.value = 0.2;
  master.connect(comp).connect(ctx.destination);

  const verb = ctx.createConvolver();
  verb.buffer = impulse(ctx, style === 'ambient' || style === 'cinematic' ? 4.5 : 3, 3.2);
  const verbOut = ctx.createGain(); verbOut.gain.value = style === 'ambient' ? 0.55 : 0.32;
  verb.connect(verbOut).connect(master);

  const duck = ctx.createGain();
  duck.connect(master);
  const duckSend = ctx.createGain(); duckSend.gain.value = 0.35;
  duck.connect(duckSend).connect(verb);

  const roots = [57, 54, 60, 55, 52, 58];
  const key = roots[model.seed % roots.length];
  const progKind = { house: 'minor', cinematic: 'minor', synthwave: 'minor', lofi: 'jazz', jazz: 'jazz', tropical: 'pop', ambient: 'float', trap: 'minor', phonk: 'minor', futurebass: 'pop', citypop: 'jazz', garage: 'minor', bossa: 'jazz', amapiano: 'jazz' }[style] || 'minor';
  const [CH, progList] = PROGS[progKind];
  const variation = (model.seed >>> 3) >>> 0;
  const names = progList[variation % progList.length];
  const groove = (variation >>> 4) % 2;     // alternate drum pattern
  const withLead = ((variation >>> 6) % 3) !== 0; // most songs get a generated melody
  // chord segments: one per bar, cycling the progression (its last chord is the finale's)
  const bars = Math.round(FINALE / 2), loopLen = names.length - 1;
  const prog = [...Array.from({ length: bars }, (_, i) => [i * 2, i * 2 + 2, names[i % loopLen]]), [FINALE, DURATION, names[loopLen]]];
  const chordAt = (t) => prog.find(([a, b]) => t >= a && t < b) || prog[prog.length - 1];
  const chord = (t) => CH[chordAt(t)[2]];

  // ---------------------------------------------------------------- instruments
  const env = (g, t, a, peak, d, end = 0.0001) => {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
    g.gain.exponentialRampToValueAtTime(end, t + a + d);
  };
  const pan = (v) => { const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, v)); return p; };
  const noiseSrc = (t, dur) => { const s = ctx.createBufferSource(); s.buffer = noise; s.loop = true; s.start(t, (t * 7.3) % 1.5); s.stop(t + dur); return s; };
  const osc = (type, f, t, dur) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.start(t); o.stop(t + dur); return o; };
  let lastDuck = -1;
  const duckAt = (t, depth = 0.3, rel = 0.24) => { if (t <= lastDuck) return; lastDuck = t; duck.gain.setValueAtTime(depth, t); duck.gain.linearRampToValueAtTime(1, t + rel); };

  function kick(t, amp = 1, sidechain = true) {
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(155, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.13);
    const g = ctx.createGain(); env(g, t, 0.002, amp, 0.45);
    o.connect(g).connect(master); o.start(t); o.stop(t + 0.5);
    const c = noiseSrc(t, 0.02);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2500;
    const cg = ctx.createGain(); env(cg, t, 0.001, 0.25 * amp, 0.015);
    c.connect(hp).connect(cg).connect(master);
    if (sidechain) duckAt(t);
  }
  function tom(t, amp = 0.8, f0 = 110) {
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f0 * 0.55, t + 0.35);
    const g = ctx.createGain(); env(g, t, 0.003, amp, 0.7);
    o.connect(g); g.connect(master); g.connect(verb);
    o.start(t); o.stop(t + 0.8);
    const s = noiseSrc(t, 0.1);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 800;
    const sg = ctx.createGain(); env(sg, t, 0.001, 0.2 * amp, 0.06);
    s.connect(bp).connect(sg).connect(master);
  }
  function clap(t, amp = 0.5, big = false) {
    const s = noiseSrc(t, 0.4);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = big ? 1200 : 1600; bp.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    [0, 0.011, 0.022].forEach((o) => { g.gain.setValueAtTime(amp, t + o); g.gain.exponentialRampToValueAtTime(amp * 0.2, t + o + 0.009); });
    g.gain.setValueAtTime(amp * 0.8, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (big ? 0.34 : 0.24));
    s.connect(bp).connect(g);
    g.connect(master);
    const send = ctx.createGain(); send.gain.value = big ? 1.6 : 1; g.connect(send).connect(verb);
  }
  function hat(t, amp = 0.12, open = false, p = 0) {
    const s = noiseSrc(t, open ? 0.3 : 0.06);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 8000;
    const g = ctx.createGain(); env(g, t, 0.001, amp, open ? 0.22 : 0.035);
    s.connect(hp).connect(g).connect(pan(p)).connect(master);
  }
  function shaker(t, amp = 0.06) {
    const s = noiseSrc(t, 0.08);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 6000; bp.Q.value = 2;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(amp, t + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    s.connect(bp).connect(g).connect(pan(0.3)).connect(master);
  }
  function ride(t, amp = 0.05) {
    [1, 1.47, 2.13].forEach((m) => {
      const o = osc('square', 3200 * m, t, 0.5);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 5000;
      const g = ctx.createGain(); env(g, t, 0.001, amp / 3, 0.4);
      o.connect(hp).connect(g).connect(pan(0.4)).connect(master);
    });
  }
  function brush(t, amp = 0.06) {
    const s = noiseSrc(t, 0.3);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 3000; bp.Q.value = 0.6;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(amp, t + 0.08); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    s.connect(bp).connect(g).connect(pan(-0.3)).connect(master);
  }
  function crackle() {
    for (let i = 0; i < 240; i++) {
      const t = (((i * 7919) % 1000) / 1000) * DURATION;
      const s = noiseSrc(t, 0.004);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 3000;
      const g = ctx.createGain(); env(g, t, 0.0005, 0.04 + 0.05 * ((i * 13) % 7) / 7, 0.003);
      s.connect(hp).connect(g).connect(master);
    }
    const hiss = noiseSrc(0, DURATION);
    const lp = ctx.createBiquadFilter(); lp.type = 'bandpass'; lp.frequency.value = 5000;
    const g = ctx.createGain(); g.gain.value = 0.006;
    hiss.connect(lp).connect(g).connect(master);
  }
  function impact(t, amp = 1) {
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(26, t + 1.4);
    const g = ctx.createGain(); env(g, t, 0.004, 0.9 * amp, 1.8);
    o.connect(g).connect(master); o.start(t); o.stop(t + 2);
    const s = noiseSrc(t, 2.4);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 3500;
    const cg = ctx.createGain(); env(cg, t, 0.003, 0.28 * amp, 2.2);
    s.connect(hp).connect(cg); cg.connect(master); cg.connect(verb);
  }
  function whoosh(t0, t1, amp = 0.25, up = true) {
    const s = noiseSrc(t0, t1 - t0 + 0.05);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(up ? 300 : 6000, t0); bp.frequency.exponentialRampToValueAtTime(up ? 7000 : 250, t1);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(amp, t1 - 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t1 + 0.04);
    const p = ctx.createStereoPanner(); p.pan.setValueAtTime(-0.8, t0); p.pan.linearRampToValueAtTime(0.8, t1);
    s.connect(bp).connect(g).connect(p); p.connect(master); p.connect(verb);
  }
  function riser(t0, t1, amp = 0.2) {
    whoosh(t0, t1, amp * 1.2, true);
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(mtof(key - 12), t0); o.frequency.exponentialRampToValueAtTime(mtof(key + 24), t1);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(400, t0); lp.frequency.exponentialRampToValueAtTime(5000, t1);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(amp * 0.4, t1); g.gain.setValueAtTime(0.0001, t1 + 0.01);
    o.connect(lp).connect(g); g.connect(master); g.connect(verb);
    o.start(t0); o.stop(t1 + 0.05);
  }
  function blip(t, midi, amp = 0.06, p = 0) {
    const o = osc('sine', mtof(midi), t, 0.15);
    const g = ctx.createGain(); env(g, t, 0.002, amp, 0.09);
    const pn = pan(p); o.connect(g).connect(pn); pn.connect(master); pn.connect(verb);
  }
  function bell(t, midi, amp = 0.08, len = 1.4, p = 0) {
    [[1, 1], [2.0, 0.35], [3.01, 0.12]].forEach(([mul, a]) => {
      const o = osc('sine', mtof(midi) * mul, t, len + 0.1);
      const g = ctx.createGain(); env(g, t, 0.003, amp * a, len / mul);
      const pn = pan(p); o.connect(g).connect(pn); pn.connect(duck); pn.connect(verb);
    });
  }
  function marimba(t, midi, amp = 0.12, p = 0) {
    [[1, 1], [4, 0.25], [9.9, 0.06]].forEach(([mul, a]) => {
      const o = osc('sine', mtof(midi) * mul, t, 0.5);
      const g = ctx.createGain(); env(g, t, 0.002, amp * a, 0.35 / Math.sqrt(mul));
      const pn = pan(p); o.connect(g).connect(pn); pn.connect(duck); pn.connect(verb);
    });
  }
  function keys(t, dur, notes, amp = 0.05) {
    // Rhodes-ish: sine + soft triangle with tremolo
    const trem = ctx.createOscillator(); trem.frequency.value = 5.2;
    const tg = ctx.createGain(); tg.gain.value = 0.25;
    const out = ctx.createGain(); env(out, t, 0.01, amp, dur + 0.4, 0.0001);
    trem.connect(tg).connect(out.gain);
    trem.start(t); trem.stop(t + dur + 0.6);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2200;
    notes.forEach((m, i) => {
      const a = osc('sine', mtof(m), t, dur + 0.6), b = osc('triangle', mtof(m) * 2.001, t, dur + 0.6);
      const bg = ctx.createGain(); bg.gain.value = 0.15;
      const pn = pan((i - notes.length / 2) * 0.15);
      a.connect(pn); b.connect(bg).connect(pn); pn.connect(lp);
    });
    lp.connect(out); out.connect(duck); out.connect(verb);
  }
  function pad(t0, t1, notes, amp = 0.045, cutoff = [900, 2400], type = 'sawtooth', attack = 0.4) {
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.7;
    lp.frequency.setValueAtTime(cutoff[0], t0); lp.frequency.linearRampToValueAtTime(cutoff[1], t1);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(amp, t0 + Math.min(attack, (t1 - t0) / 2));
    g.gain.setValueAtTime(amp, Math.max(t0 + Math.min(attack, (t1 - t0) / 2) + 0.01, t1 - 0.05));
    g.gain.exponentialRampToValueAtTime(0.0001, t1 + 0.5);
    lp.connect(g).connect(duck);
    notes.forEach((m, i) => {
      for (const det of [-8, 8]) {
        const o = osc(type, mtof(m), t0, t1 - t0 + 0.6);
        o.detune.value = det + i;
        o.connect(pan(det > 0 ? 0.4 : -0.4)).connect(lp);
      }
    });
  }
  function bass(t, dur, midi, amp = 0.2, type = 'sawtooth', cut = 1400) {
    const o = osc(type, mtof(midi), t, dur + 0.05), s = osc('sine', mtof(midi), t, dur + 0.05);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 6;
    lp.frequency.setValueAtTime(cut, t); lp.frequency.exponentialRampToValueAtTime(180, t + dur);
    const g = ctx.createGain(); env(g, t, 0.004, amp, dur);
    o.connect(lp).connect(g); s.connect(g); g.connect(duck);
  }
  function arp(t, midi, amp = 0.05, cutoff = 3000) {
    const o = osc('sawtooth', mtof(midi), t, 0.2);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(cutoff, t); lp.frequency.exponentialRampToValueAtTime(400, t + 0.15);
    const g = ctx.createGain(); env(g, t, 0.003, amp, 0.14);
    o.connect(lp).connect(g); g.connect(duck); g.connect(verb);
  }

  const shaper = (amount) => {
    const ws = ctx.createWaveShaper();
    const n = 1024, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(x * amount); }
    ws.curve = curve;
    return ws;
  };
  function sub808(t, dur, midi, amp = 0.45, from = null, drive = 2) {
    const o = ctx.createOscillator();
    if (from != null) { o.frequency.setValueAtTime(mtof(from), t); o.frequency.exponentialRampToValueAtTime(mtof(midi), t + 0.09); }
    else o.frequency.setValueAtTime(mtof(midi), t);
    const g = ctx.createGain(); env(g, t, 0.004, amp, dur);
    o.connect(shaper(drive)).connect(g).connect(master);
    o.start(t); o.stop(t + dur + 0.05);
  }
  function cowbell(t, midi, amp = 0.1, p = 0) {
    const f = mtof(midi);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f * 2; bp.Q.value = 1.2;
    const g = ctx.createGain(); env(g, t, 0.002, amp, 0.16);
    [1, 1.48].forEach((m) => osc('square', f * m, t, 0.2).connect(bp));
    const pn = pan(p); bp.connect(g).connect(pn); pn.connect(master); pn.connect(verb);
  }
  function supersaw(t, dur, notes, amp = 0.03, cutoff = 5200) {
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = cutoff;
    const g = ctx.createGain(); env(g, t, 0.01, amp, dur);
    lp.connect(g); g.connect(duck); g.connect(verb);
    notes.forEach((m) => [-18, -7, 0, 7, 18].forEach((det, k) => { const o = osc('sawtooth', mtof(m), t, dur + 0.1); o.detune.value = det; o.connect(pan((k - 2) * 0.3)).connect(lp); }));
  }
  function pluck(t, midi, amp = 0.08, len = 0.28, type = 'sawtooth') {
    const o = osc(type, mtof(midi), t, len + 0.05);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 3;
    lp.frequency.setValueAtTime(4200, t); lp.frequency.exponentialRampToValueAtTime(350, t + len * 0.6);
    const g = ctx.createGain(); env(g, t, 0.002, amp, len);
    o.connect(lp).connect(g); g.connect(duck); g.connect(verb);
  }
  function logdrum(t, midi, amp = 0.35) {
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(mtof(midi) * 2.2, t); o.frequency.exponentialRampToValueAtTime(mtof(midi), t + 0.035);
    const g = ctx.createGain(); env(g, t, 0.002, amp, 0.4);
    o.connect(shaper(1.6)).connect(g).connect(master);
    o.start(t); o.stop(t + 0.5);
  }
  function rim(t, amp = 0.08, p = -0.2) {
    const o = osc('square', 1750, t, 0.03);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2200; bp.Q.value = 3;
    const g = ctx.createGain(); env(g, t, 0.001, amp, 0.025);
    o.connect(bp).connect(g).connect(pan(p)).connect(master);
  }
  function chop(t, midi, amp = 0.06) { // vocal-chop-ish: sine through a vowel formant
    const o = osc('sawtooth', mtof(midi), t, 0.22);
    const f1 = ctx.createBiquadFilter(); f1.type = 'bandpass'; f1.frequency.value = 700; f1.Q.value = 6;
    const f2 = ctx.createBiquadFilter(); f2.type = 'bandpass'; f2.frequency.value = 1200; f2.Q.value = 6;
    const g = ctx.createGain(); env(g, t, 0.01, amp, 0.18);
    o.connect(f1).connect(g); o.connect(f2).connect(g); g.connect(duck); g.connect(verb);
  }
  // seeded 8th-note motif over the chords, varied every other bar
  function melody(t0, t1, octave, voice, density = 0.6) {
    let sd = (model.seed ^ 0x5bd1e995) >>> 0;
    const rnd = () => ((sd = (Math.imul(sd, 1103515245) + 12345) >>> 0) / 4294967296);
    const motif = Array.from({ length: 8 }, (_, i) => ({ on: i === 0 || rnd() < density, deg: Math.floor(rnd() * 4), len: rnd() < 0.3 ? 2 : 1 }));
    for (const bar of beats(t0, t1, BAR)) {
      const vary = Math.round(bar / BAR) % 2 === 1;
      motif.forEach((n, i) => {
        if (!n.on) return;
        const t = bar + (i * BEAT) / 2;
        if (t >= t1) return;
        const c = chord(t);
        const deg = vary && i >= 4 ? (n.deg + 2) % 4 : n.deg;
        voice(t, key + octave + c[deg % c.length], (BEAT / 2) * n.len, i);
      });
    }
  }

  const beats = (a, b, step = BEAT) => { const out = []; for (let t = a; t < b - 1e-6; t += step) out.push(Math.round(t * 1000) / 1000); return out; };
  const beatIdx = (t) => Math.round(t / BEAT);
  const root = (t) => key + chord(t)[0] - (chord(t)[0] > 6 ? 12 : 0);
  const END = FINALE;                 // groove runs 0 → finale
  const inBreak = () => false;     // no breaks: the cards run back to back
  const ROLL = END - 1;               // snare roll into the finale
  const [V0, V1] = [CARDS_START, FINALE];
  // the real cut list for this video (multi-review cards make it vary)
  const CUT_T = events?.cuts || QUOTE_CUTS.slice(1, -1);
  const SWAP_T = events?.swaps || QUOTE_CUTS.slice(0, -1).map((t) => t + 1);
  const HIT_L = events?.hits || HITS;

  // ---------------------------------------------------------------- shared SFX
  function commonFx(level = 1) {
    whoosh(CARDS_START - 0.35, CARDS_START, 0.26 * level, true);
    CUT_T.forEach((t, i) => whoosh(t - 0.18, t + 0.02, 0.16 * level, i % 2 === 0));
    // every photo swap / new review gets a tiny tick
    SWAP_T.forEach((t, i) => blip(t, key + 36 + [0, 3, 7, 10][i % 4], 0.035 * level, i % 2 ? 0.5 : -0.5));
    for (const h of HIT_L) if (h.amp >= 0.6) impact(h.t, h.amp * level);
  }
  function chordPads(amp, cutoff, type = 'sawtooth', attack = 0.4) {
    for (const [a, b, n] of prog.slice(0, -1)) pad(a, b, CH[n].map((x) => key + x), amp, cutoff, type, attack);
  }
  function finale(bellAmp = 0.07) {
    pad(END, DURATION, CH[prog[prog.length - 1][2]].map((x) => key + x), 0.045, [2400, 600]);
    bass(END, 2.4, key - 24, 0.22);
    CH[prog[prog.length - 1][2]].concat([19, 24]).forEach((x, i) => bell(END + 0.05 + (i * BEAT) / 2, key + 12 + x, bellAmp, 2.2, i % 2 ? 0.4 : -0.4));
  }
  function roll(amp = 0.35, fn = clap) {
    for (let t = ROLL, step = BEAT / 2; t < END - 1e-6; t += step) { fn(t, 0.12 + amp * (t - ROLL)); if (t >= ROLL + 0.5) step = BEAT / 4; if (t >= ROLL + 0.75) step = BEAT / 8; }
  }
  const voiceBells = (amp, octave = 12) => {
    for (const t of beats(V0, V1, BEAT / 2)) { const c = chord(t); const k = Math.round((t - V0) / (BEAT / 2)); bell(t, key + octave + c[[0, 2, 1, 3, 4, 2, 1, 3][k % 8]], amp, 0.9, k % 2 ? 0.35 : -0.35); }
  };

  // ---------------------------------------------------------------- arrangements
  const ARR = {
    trap() {
      const kicks = groove ? [0, 1.5, 2.75] : [0, 0.75, 2.5];
      for (const bar of beats(0, END, BAR)) {
        kicks.forEach((b, i) => { const t = bar + b * BEAT; if (t < END) { kick(t, 0.8); const r = root(t) - 24; sub808(t, 0.55, r, 0.5, i ? r + 5 : null, 2.5); } });
        clap(bar + 2 * BEAT, 0.5, true);
        for (let k = 0; k < 8; k++) hat(bar + (k * BEAT) / 2, 0.08, false, 0.25);
        if (Math.round(bar / BAR) % 2 === 1) for (let k = 0; k < 6; k++) hat(bar + 3 * BEAT + (k * BEAT) / 6, 0.05 + k * 0.01, false, -0.25);
      }
      chordPads(0.025, [500, 1200]);
      if (withLead) melody(0, END, 24, (t, m) => bell(t, m, 0.05, 0.5, 0.2), 0.45);
      roll(0.3); commonFx(); kick(END, 1); sub808(END, 2, key - 24, 0.5); finale(0.06);
    },
    phonk() {
      for (const bar of beats(0, END, BAR)) {
        (groove ? [0, 0.75, 1.5, 2.5, 3.25] : [0, 1, 1.75, 2.5]).forEach((b) => { const t = bar + b * BEAT; if (t < END) kick(t, 0.85); });
        clap(bar + BEAT, 0.45); clap(bar + 3 * BEAT, 0.45);
        for (let k = 0; k < 16; k++) hat(bar + (k * BEAT) / 4, k % 4 === 2 ? 0.09 : 0.05, k % 8 === 6, 0.3);
        sub808(bar, BAR - 0.1, root(bar) - 24, 0.55, root(bar) - 17, 4);
      }
      // the signature cowbell line on 16ths
      melody(0, END, 24, (t, m, d, i) => { cowbell(t, m, 0.11, i % 2 ? 0.3 : -0.3); if (d > BEAT / 2) cowbell(t + BEAT / 4, m, 0.08); }, 0.75);
      chordPads(0.02, [400, 900]);
      commonFx(1.1); kick(END, 1); sub808(END, 2.2, key - 24, 0.55, key - 12, 4);
    },
    futurebass() {
      for (const t of beats(0, END)) { const b = beatIdx(t) % 4; kick(t, b % 2 ? 0.45 : 0.8); if (b === 1 || b === 3) clap(t, 0.5, true); hat(t + BEAT / 2, 0.07, false, 0.3); }
      const stab = groove ? [0, 0.75, 1.5, 2.5, 3] : [0.5, 1, 1.75, 2.5, 3.5];
      for (const bar of beats(0, END, BAR)) stab.forEach((b) => { const t = bar + b * BEAT; if (t < END) supersaw(t, 0.22, chord(t).slice(0, 4).map((x) => key + x + 12), 0.028); });
      for (const bar of beats(0, END, BAR)) sub808(bar, BAR - 0.1, root(bar) - 24, 0.4, null, 1.2);
      if (withLead) melody(0, END, 24, (t, m, d) => pluck(t, m, 0.07, d + 0.1), 0.6);
      melody(0, END, 12, (t, m, d, i) => { if (i % 3 === 0) chop(t, m + 12, 0.05); }, 0.5);
      roll(0.35); commonFx(); kick(END, 1); finale(0.07);
    },
    citypop() {
      for (const bar of beats(0, END, BAR)) {
        (groove ? [0, 1.5, 2.25] : [0, 2, 2.75]).forEach((b) => kick(bar + b * BEAT, 0.6, false));
        clap(bar + BEAT, 0.35); clap(bar + 3 * BEAT, 0.35);
        for (let k = 0; k < 16; k++) hat(bar + (k * BEAT) / 4, k % 2 ? 0.035 : 0.06, false, 0.25);
        // slap bass: octave-jumping 8ths
        for (let k = 0; k < 8; k++) { const t = bar + (k * BEAT) / 2; bass(t, 0.18, root(t) - 24 + [0, 12, 0, 7, 12, 0, 10, 12][k], 0.26, 'sawtooth', 1800); }
        keys(bar + BEAT / 2, 0.35, chord(bar).slice(1).map((x) => key + x), 0.06);
        keys(bar + 2.5 * BEAT, 0.35, chord(bar).slice(1).map((x) => key + x), 0.06);
        supersaw(bar + 3.5 * BEAT, 0.14, chord(bar).slice(0, 3).map((x) => key + x + 12), 0.03, 3000);
      }
      if (withLead) melody(0, END, 24, (t, m, d) => pluck(t, m, 0.06, d + 0.15, 'square'), 0.55);
      commonFx(0.8); keys(END, 2.8, CH[prog[prog.length - 1][2]].map((x) => key + x), 0.07); bass(END, 2.4, key - 24, 0.22);
    },
    garage() {
      const sw = BEAT / 6;
      for (const bar of beats(0, END, BAR)) {
        (groove ? [0, 2.5] : [0, 1.75, 2.5]).forEach((b) => kick(bar + b * BEAT, 0.8));
        clap(bar + BEAT, 0.4); clap(bar + 3 * BEAT, 0.4); rim(bar + 3.75 * BEAT, 0.05);
        for (let k = 0; k < 8; k++) hat(bar + (k * BEAT) / 2 + (k % 2 ? sw : 0), k % 2 ? 0.08 : 0.05, k === 7, 0.3);
        [0, 0.75, 2.5, 3].forEach((b) => sub808(bar + b * BEAT, 0.3, root(bar) - 24, 0.35, null, 1.3));
        [0.5, 1.75, 2.75].forEach((b) => pluck(bar + b * BEAT, key + chord(bar)[1] + 12, 0.05, 0.2, 'square'));
      }
      melody(0, END, 24, (t, m, d, i) => { if (i % 2 === 0) chop(t, m, 0.06); }, 0.5);
      chordPads(0.02, [900, 1800], 'square');
      commonFx(0.9); kick(END, 1); finale(0.06);
    },
    bossa() {
      const clave = groove ? [0, 0.75, 1.5, 2.5, 3.25] : [0, 1, 1.75, 2.75, 3.25];
      for (const bar of beats(0, END, BAR)) {
        clave.forEach((b) => rim(bar + b * BEAT, 0.07));
        for (let k = 0; k < 16; k++) shaker(bar + (k * BEAT) / 4, k % 4 === 0 ? 0.05 : 0.03);
        bass(bar, BEAT * 1.4, root(bar) - 24, 0.22, 'triangle', 600);
        bass(bar + 2 * BEAT, BEAT * 1.4, root(bar) - 17, 0.2, 'triangle', 600);
        [0, 0.75, 1.5, 2, 2.75, 3.5].forEach((b) => chord(bar).slice(1, 4).forEach((x, i) => pluck(bar + b * BEAT + i * 0.012, key + x, 0.035, 0.35, 'triangle')));
        kick(bar, 0.3, false); kick(bar + 2 * BEAT, 0.25, false);
      }
      if (withLead) melody(0, END, 24, (t, m, d) => bell(t, m, 0.04, d + 0.4, 0.2), 0.4);
      chordPads(0.018, [700, 1200], 'sine', 0.6);
      commonFx(0.5); keys(END, 2.8, CH[prog[prog.length - 1][2]].map((x) => key + x), 0.06); bass(END, 2.4, key - 24, 0.2, 'triangle', 600);
    },
    amapiano() {
      for (const bar of beats(0, END, BAR)) {
        for (let k = 0; k < 4; k++) kick(bar + k * BEAT, 0.5, false);
        rim(bar + BEAT, 0.06); rim(bar + 3 * BEAT, 0.06); clap(bar + 3 * BEAT, 0.2);
        for (let k = 0; k < 16; k++) shaker(bar + (k * BEAT) / 4, k % 2 ? 0.04 : 0.06);
        // the log drum
        (groove ? [0.75, 1.5, 2.25, 3] : [0.5, 1.25, 2.5, 3.25]).forEach((b, i) => logdrum(bar + b * BEAT, root(bar) - 24 + (i === 2 ? 7 : 0), 0.4));
        keys(bar, BAR - 0.1, chord(bar).map((x) => key + x), 0.05);
      }
      if (withLead) melody(0, END, 24, (t, m, d) => keys(t, d, [m], 0.04), 0.35);
      commonFx(0.7); keys(END, 2.8, CH[prog[prog.length - 1][2]].map((x) => key + x), 0.07); logdrum(END, key - 24, 0.45);
    },
    house() {
      for (const t of beats(0, END)) {
        const b = beatIdx(t) % 4;
        if (!inBreak(t)) { kick(t, 0.72); hat(t + BEAT / 2, 0.11, b === 3, 0.3); if (b === 1 || b === 3) clap(t, 0.42); }
        if (t >= V1) { hat(t + BEAT / 4, 0.07, false, -0.3); hat(t + (3 * BEAT) / 4, 0.07, false, -0.3); }
      }
      for (const t of beats(0, END, BEAT / 2)) { if (inBreak(t)) continue; const off = Math.round(t / (BEAT / 2)) % 2 === 1; bass(t, BEAT / 2 - 0.02, root(t) - 24 + (off ? 12 : 0), off ? 0.24 : 0.3); }
      chordPads(0.05, [800, 2600]);
      voiceBells(0.08);
      if (withLead && groove) melody(0, END, 24, (t, m, d) => pluck(t, m, 0.045, d), 0.5);
      roll(0.35); riser(ROLL - 0.2, END, 0.2); commonFx(); kick(END, 1); finale();
    },
    lofi() {
      crackle();
      for (const t of beats(0, END, BAR / 2)) keys(t, BAR / 2 - 0.1, chord(t).map((x) => key + x), 0.055);
      const swing = BEAT * 0.18;
      for (const t of beats(0, END, BAR)) {
        if (!inBreak(t)) { kick(t, 0.6, false); kick(t + BEAT * 1.5, 0.45, false); clap(t + BEAT * 2, 0.3); duckAt(t, 0.6, 0.3); }
        for (let k = 0; k < 8; k++) { const ht = t + (k * BEAT) / 2 + (k % 2 ? swing : 0); if (!inBreak(ht) && ht < END) hat(ht, k % 2 ? 0.05 : 0.08, false, 0.2); }
      }
      for (const t of beats(0, END, BEAT)) { if (inBreak(t)) continue; const b = beatIdx(t) % 4; if (b === 0 || b === 2) bass(t, BEAT * 0.9, root(t) - 24, 0.22, 'sine', 400); }
      for (const t of beats(V0, V1, BEAT)) { const c = chord(t); bell(t + swing, key + 24 + c[(beatIdx(t) * 2) % c.length], 0.035, 0.8, 0.3); }
      commonFx(0.6);
      keys(END, 2.8, CH[prog[prog.length - 1][2]].map((x) => key + x), 0.06);
      bass(END, 2.5, key - 24, 0.2, 'sine', 400);
    },
    cinematic() {
      chordPads(0.06, [500, 1800], 'sawtooth', 0.6);
      for (const t of beats(0, END, BEAT)) {
        const b = beatIdx(t) % 4;
        if (inBreak(t)) continue;
        if (b === 0) tom(t, 0.9, 90); if (b === 2) tom(t, 0.7, 110); if (b === 3 && t > V0) tom(t + BEAT / 2, 0.5, 130);
      }
      for (const t of beats(0, END, BEAT / 2)) { if (inBreak(t)) continue; const c = chord(t); const k = Math.round(t / (BEAT / 2)); marimba(t, key + 12 + c[[0, 1, 2, 1, 3, 2, 1, 2][k % 8]], 0.05, k % 2 ? 0.3 : -0.3); }
      for (const t of beats(0, END, BAR)) bass(t, BAR - 0.1, root(t) - 24, 0.2, 'sawtooth', 500);
      roll(0.5, (t, a) => tom(t, a, 140));
      commonFx(1.2); impact(END, 1.2); finale(0.08);
    },
    synthwave() {
      for (const t of beats(0, END)) {
        const b = beatIdx(t) % 4;
        if (!inBreak(t)) { kick(t, 0.7); if (b === 1 || b === 3) clap(t, 0.5, true); hat(t + BEAT / 2, 0.08, false, 0.3); }
      }
      for (const t of beats(0, END, BEAT / 4)) { if (inBreak(t)) continue; const c = chord(t); const k = Math.round(t / (BEAT / 4)); arp(t, key + 12 + c[[0, 1, 2, 3, 2, 1][k % 6]], 0.045, 2000 + 2000 * Math.sin(t)); }
      for (const t of beats(0, END, BEAT / 2)) { if (inBreak(t)) continue; bass(t, BEAT / 2 - 0.03, root(t) - 24 + (Math.round(t / (BEAT / 2)) % 2 ? 12 : 0), 0.25, 'sawtooth', 900); }
      chordPads(0.045, [1200, 3500]);
      roll(0.3);
      commonFx(); kick(END, 1); finale();
    },
    tropical() {
      for (const t of beats(0, END)) {
        const b = beatIdx(t) % 4;
        if (!inBreak(t)) { kick(t, 0.6); if (b === 1 || b === 3) clap(t, 0.3); }
      }
      for (const t of beats(0, END, BEAT / 4)) if (!inBreak(t)) shaker(t, Math.round(t / (BEAT / 4)) % 2 ? 0.035 : 0.06);
      const pat = [0, 0.75, 1.5, 2, 2.75, 3.25];
      for (const t of beats(0, END, BAR)) {
        pat.forEach((o, i) => { const tt = t + o * BEAT; if (tt < END && !inBreak(tt)) { const c = chord(tt); marimba(tt, key + 12 + c[i % 4], 0.1, i % 2 ? 0.4 : -0.4); } });
        [0.5, 1.5, 2.5, 3.5].forEach((o) => { const tt = t + o * BEAT; if (tt < END && !inBreak(tt)) bass(tt, BEAT * 0.4, root(tt) - 12, 0.22, 'triangle', 800); });
      }
      chordPads(0.025, [1500, 2500], 'triangle');
      if (withLead) melody(0, END, 24, (t, m) => marimba(t, m, 0.07, 0.3), 0.5);
      commonFx(0.8); kick(END, 0.9); finale(0.08);
    },
    ambient() {
      pad(0, DURATION, [key - 12, key - 5], 0.03, [300, 900], 'sine', 1);
      for (const [a, b, n] of prog) pad(a, b + 0.8, CH[n].map((x) => key + x + 12), 0.035, [900, 1600], 'triangle', 0.8);
      for (const t of beats(0, END, BAR)) kick(t, 0.25, false);
      let k = 0;
      for (const t of beats(0.25, DURATION - 1, BEAT)) { if ((k++ * 5) % 3 === 0) { const c = chord(t); bell(t, key + 24 + c[(k * 2) % c.length], 0.05, 2.4, ((k % 5) - 2) / 3); } }
      for (const h of HIT_L) if (h.amp >= 0.6) { if (h.t > 0.8) whoosh(h.t - 0.8, h.t, 0.12, true); impact(h.t, 0.3); }
      finale(0.06);
    },
    jazz() {
      const swing = BEAT * 0.17;
      for (const t of beats(0, END)) {
        if (inBreak(t)) continue;
        const b = beatIdx(t) % 4;
        ride(t, 0.05);
        if (b === 1 || b === 3) { ride(t + BEAT / 2 + swing, 0.03); brush(t, 0.05); hat(t, 0.05, false, -0.2); }
        if (b === 0) kick(t, 0.35, false);
        const c = chord(t);
        const walk = [c[0], c[2], c[1], c[3] ?? c[0] + 12][b];
        bass(t, BEAT * 0.9, key - 24 + walk, 0.25, 'triangle', 700);
      }
      for (const t of beats(0, END, BAR / 2)) { const tt = t + BEAT + BEAT / 2 + swing; if (tt < END && !inBreak(tt)) keys(tt, 0.35, chord(tt).slice(1).map((x) => key + x), 0.06); }
      for (const t of beats(V0, V1, BEAT)) { const c = chord(t); bell(t + (Math.round(t * 2) % 2 ? swing : 0), key + 24 + c[(beatIdx(t) * 3) % c.length], 0.03, 0.7, 0.3); }
      commonFx(0.55);
      keys(END, 2.8, CH[prog[prog.length - 1][2]].map((x) => key + x), 0.07);
      bass(END, 2.5, key - 24, 0.22, 'triangle', 600);
      ride(END, 0.06);
    },
  };
  (ARR[style] || ARR.house)();

  // ---------------------------------------------------------------- energy layer
  // Sound effects placed on the exact moments the picture reacts (see energy.js sfxEvents).
  if (energy && energy.sfx && events) {
    const L = energy.sfx;
    const popLevel = events.voiced ? 0.35 : 1; // pops sit under the voiceover
    const pop = (t, i) => {
      const o = ctx.createOscillator();
      const f = 700 + (i % 6) * 90;
      o.frequency.setValueAtTime(f * 1.8, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.035);
      const g = ctx.createGain(); env(g, t, 0.001, 0.09 * L * popLevel, 0.05);
      o.connect(g).connect(pan(((i % 3) - 1) * 0.3)).connect(master);
      o.start(t); o.stop(t + 0.08);
    };
    const tick = (t, i) => {
      const o = osc('square', 1800 + i * 220, t, 0.03);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1500;
      const g = ctx.createGain(); env(g, t, 0.001, 0.05 * L, 0.02);
      o.connect(hp).connect(g).connect(master);
    };
    const boing = (t, i) => {
      const o = ctx.createOscillator(); o.type = 'triangle';
      o.frequency.setValueAtTime(320, t); o.frequency.exponentialRampToValueAtTime(980, t + 0.09); o.frequency.exponentialRampToValueAtTime(620, t + 0.2);
      const g = ctx.createGain(); env(g, t, 0.003, 0.13 * L, 0.22);
      const pn = pan(i % 2 ? 0.5 : -0.5);
      o.connect(g).connect(pn); pn.connect(master); pn.connect(verb);
      o.start(t); o.stop(t + 0.3);
    };
    const vineBoom = (t) => {
      [[58, 1], [116, 0.45], [174, 0.18]].forEach(([f, a]) => {
        const o = ctx.createOscillator();
        o.frequency.setValueAtTime(f * 1.25, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.06);
        const g = ctx.createGain(); env(g, t, 0.004, 0.55 * a * L, 1.1);
        const sh = shaper(3);
        o.connect(sh).connect(g); g.connect(master); g.connect(verb);
        o.start(t); o.stop(t + 1.3);
      });
      duckAt(t, 0.15, 0.6);
    };
    const scratch = (t) => {
      const s = noiseSrc(t, 0.4);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 4;
      bp.frequency.setValueAtTime(700, t); bp.frequency.exponentialRampToValueAtTime(3200, t + 0.12); bp.frequency.exponentialRampToValueAtTime(500, t + 0.3);
      const g = ctx.createGain(); env(g, t, 0.005, 0.35 * L, 0.3);
      s.connect(bp).connect(g).connect(master);
      const o = ctx.createOscillator(); o.type = 'sawtooth';
      o.frequency.setValueAtTime(180, t); o.frequency.exponentialRampToValueAtTime(900, t + 0.12); o.frequency.exponentialRampToValueAtTime(120, t + 0.3);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400;
      const og = ctx.createGain(); env(og, t, 0.005, 0.12 * L, 0.28);
      o.connect(lp).connect(og).connect(master);
      o.start(t); o.stop(t + 0.35);
    };
    const reverseCymbal = (t0, t1) => {
      const s = noiseSrc(t0, t1 - t0 + 0.02);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 5000;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.3 * L, t1 - 0.01); g.gain.setValueAtTime(0.0001, t1);
      s.connect(hp).connect(g); g.connect(master); g.connect(verb);
    };
    if (energy.hats16 && !['ambient', 'jazz'].includes(style)) {
      for (const t of beats(0, END, BEAT / 4)) if (Math.round(t / (BEAT / 4)) % 2) hat(t, 0.04 * L, false, Math.round(t * 8) % 2 ? 0.4 : -0.4);
    }
    events.pops.forEach((t, i) => pop(t, i));
    events.ticks.forEach((t, i) => tick(t, i));
    events.stickers.forEach((t, i) => boing(t, i));
    events.booms.forEach((t) => impact(t, 0.45 * L));
    events.freeze.forEach((t) => vineBoom(t));
    events.scratch.forEach((t) => scratch(t));
    events.swells.forEach(([a, b]) => reverseCymbal(a, b));
    // overdrive: a laser zap under every light streak (snares)
    (events.zaps || []).forEach((t, i) => {
      const o = ctx.createOscillator(); o.type = 'sawtooth';
      o.frequency.setValueAtTime(2400, t); o.frequency.exponentialRampToValueAtTime(180, t + 0.12);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1400; bp.Q.value = 1.5;
      const g = ctx.createGain(); env(g, t, 0.002, 0.06 * L, 0.12);
      const pn = pan(i % 2 ? 0.6 : -0.6);
      o.connect(bp).connect(g).connect(pn); pn.connect(master); pn.connect(verb);
      o.start(t); o.stop(t + 0.16);
    });
  }

  // ---------------------------------------------------------------- voiceover
  // each review read in its own voice, starting on the card's downbeat; the music (master) ducks under it
  if (speech?.length) {
    const voiceBus = ctx.createGain(); voiceBus.gain.value = 1.35;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 90;
    const vcomp = ctx.createDynamicsCompressor(); vcomp.threshold.value = -20; vcomp.ratio.value = 4; vcomp.attack.value = 0.003; vcomp.release.value = 0.12;
    const vverb = ctx.createGain(); vverb.gain.value = 0.08;
    voiceBus.connect(hp).connect(vcomp).connect(comp);
    vcomp.connect(vverb).connect(verb);
    const sorted = [...speech].sort((a, b) => a.start - b.start);
    const spans = [];
    for (const s2 of sorted) {
      const src = ctx.createBufferSource();
      src.buffer = s2.buffer;
      src.connect(voiceBus);
      src.start(s2.start);
      const a = Math.max(0.03, s2.start - 0.04), b = s2.start + s2.dur;
      const last = spans[spans.length - 1];
      if (last && a - last[1] < 0.25) last[1] = Math.max(last[1], b); else spans.push([a, b]); // back-to-back reads share one duck
    }
    // duck the music bed: down fast, back up right after the read
    for (const [a, b] of spans) {
      master.gain.setValueAtTime(0.85, a);
      master.gain.linearRampToValueAtTime(0.42, a + 0.05);
      master.gain.setValueAtTime(0.42, b);
      master.gain.linearRampToValueAtTime(0.85, Math.min(b + 0.12, DURATION - 0.81));
    }
  }

  const buf = await ctx.startRendering();
  // loudness-normalise every style to the same level (~-16 dB RMS) with a soft limiter,
  // so switching music never makes one version much quieter than another
  const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  let sq = 0, n = 0;
  for (const d of chans) for (let i = 0; i < d.length; i += 3) { sq += d[i] * d[i]; n++; }
  const rms = Math.sqrt(sq / Math.max(1, n)) || 1e-6;
  const g = Math.min(12, 10 ** (-16 / 20) / rms);
  const T = 0.72, K2 = 0.17; // soft knee; ceiling ≈ -1 dBFS
  for (const d of chans) for (let i = 0; i < d.length; i++) {
    const y = d[i] * g, a = Math.abs(y);
    d[i] = a <= T ? y : Math.sign(y) * (T + K2 * Math.tanh((a - T) / K2));
  }
  return buf;
}
