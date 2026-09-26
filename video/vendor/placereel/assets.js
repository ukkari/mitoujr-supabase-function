// Loads every pixel the reel needs up front (photos, avatars, map tiles, fonts)
// so frame rendering is synchronous and deterministic — required for export.

const proxied = (u) => `/api/img?u=${encodeURIComponent(u)}`;

async function loadBitmap(url, timeout = 15000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(proxied(url), { signal: ctl.signal });
    if (!r.ok) throw new Error(r.status);
    return await createImageBitmap(await r.blob());
  } finally {
    clearTimeout(timer);
  }
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k], k); } catch { out[k] = null; }
    }
  }));
  return out;
}

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, max ? d / max : 0, max];
}

// Per-photo stats: colourfulness, brightness, hue histogram, and a pre-blurred copy.
function analyse(bmp) {
  const s = 48;
  const c = new OffscreenCanvas(s, s);
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(bmp, 0, 0, s, s);
  const px = x.getImageData(0, 0, s, s).data;
  const hues = new Float32Array(24);
  const vivid = new Float32Array(24); // only strongly saturated pixels: logos, signage, noren, uniforms
  let sat = 0, val = 0, lum2 = 0, lum = 0;
  for (let i = 0; i < px.length; i += 4) {
    const [h, sv, v] = rgbToHsv(px[i], px[i + 1], px[i + 2]);
    sat += sv; val += v;
    const L = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    lum += L; lum2 += L * L;
    if (v > 0.3 && sv > 0.25) hues[Math.floor(h / 15) % 24] += sv * v * sv;
    if (v > 0.3 && sv > 0.55) vivid[Math.floor(h / 15) % 24] += sv ** 3 * v;
  }
  const n = px.length / 4;
  const meanL = lum / n;
  const contrast = Math.sqrt(Math.max(0, lum2 / n - meanL * meanL)) / 128;
  const blur = new OffscreenCanvas(256, Math.max(1, Math.round((256 * bmp.height) / bmp.width)));
  const bx = blur.getContext('2d');
  bx.filter = 'blur(14px) saturate(1.3)';
  bx.drawImage(bmp, -24, -24, blur.width + 48, blur.height + 48);
  return {
    sat: sat / n, val: val / n, contrast, hues, vivid,
    aspect: bmp.width / bmp.height,
    blurred: blur,
  };
}

// Warm light, wood, skin and fried food put almost every food/interior photo in 15–50°.
// That band says little about a place, so it counts for less when picking its colour.
const WARM_PENALTY = (h) => (h >= 12 && h <= 52 ? 0.4 : 1);

function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  return [h, s, l];
}

// The place's own colour, picked from its photos: strongly saturated pixels only,
// the place's listing photo (usually the storefront/sign) weighted ×3, warm light down-weighted,
// neighbouring hue bins merged into families.
export function signatureHue(photos) {
  const hist = new Float32Array(24);
  photos.slice(0, 14).forEach((p) => {
    const w = p.from === 'place' ? 3 : 1;
    (p.stats.vivid || p.stats.hues).forEach((v, k) => { hist[k] += v * w * WARM_PENALTY(k * 15 + 7.5); });
  });
  let best = -1, bestV = 0;
  for (let k = 0; k < 24; k++) {
    const v = hist[k] + 0.6 * (hist[(k + 23) % 24] + hist[(k + 1) % 24]);
    if (v > bestV) { bestV = v; best = k; }
  }
  if (best < 0 || bestV < 0.5) return null;
  // centre on the weighted mean of the winning family
  const ks = [(best + 23) % 24, best, (best + 1) % 24];
  let sx = 0, sy = 0;
  ks.forEach((k) => { const a = ((k * 15 + 7.5) * Math.PI) / 180; sx += Math.cos(a) * hist[k]; sy += Math.sin(a) * hist[k]; });
  return ((Math.atan2(sy, sx) * 180) / Math.PI + 360) % 360;
}

export function pickPalette(photos, category, accentHex = null) {
  const hsl = (h, s, l, a = 1) => `hsla(${(((h % 360) + 360) % 360).toFixed(1)}, ${s.toFixed(0)}%, ${l.toFixed(0)}%, ${a})`;
  let hue, sat = 92, lit = 62, source;
  if (accentHex && /^#[0-9a-f]{6}$/i.test(accentHex)) {
    // the director's signature colour: keep its character, only clamp for legibility on dark
    const [h, s, l] = hexToHsl(accentHex);
    hue = h; sat = Math.max(55, Math.min(96, s * 100)); lit = Math.max(50, Math.min(70, l * 100));
    source = 'director';
  } else {
    const sig = signatureHue(photos);
    const cat = (category || '').toLowerCase();
    hue = sig ?? (/hotel|resort|inn|ryokan/.test(cat) ? 44 : /cafe|coffee|tea/.test(cat) ? 200 : 350);
    source = sig == null ? 'category' : 'photos';
    // muddy olive greens read badly on dark: push to a clean green
    if (hue >= 60 && hue < 100) hue = 140;
  }
  return {
    hue, source,
    accent: hsl(hue, sat, lit),
    accentSoft: hsl(hue, sat * 0.87, lit, 0.35),
    accent2: hsl(hue + 18, Math.min(100, sat), Math.min(80, lit + 10)),
    accentDeep: hsl(hue, sat * 0.75, Math.max(26, lit * 0.55)),
    ink: hsl(hue, 30, 8),
    bg: hsl(hue, 28, 5),
    bg2: hsl(hue + 12, 30, 10),
    paper: hsl(hue, 30, 96),
    hsl,
  };
}

// ---- map tiles (Esri World Imagery — satellite, 256px) ----
export const TILE_URL = (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
export const tileLevel = (z, k, bias = 0) => Math.max(2, Math.min(18, Math.round(z + Math.log2(k) - bias)));

export function project(lat, lng, z) {
  const n = 256 * 2 ** z;
  const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return [((lng + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
}

export function tilesFor(lat, lng, z, halfW, halfH, k, bias = 0) {
  const L = tileLevel(z, k, bias);
  const s = k * 2 ** (z - L);
  const [X, Y] = project(lat, lng, L);
  const n = 2 ** L;
  const out = [];
  const x0 = Math.floor((X - halfW / s) / 256), x1 = Math.floor((X + halfW / s) / 256);
  const y0 = Math.max(0, Math.floor((Y - halfH / s) / 256)), y1 = Math.min(n - 1, Math.floor((Y + halfH / s) / 256));
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) out.push([L, ((tx % n) + n) % n, ty]);
  return out;
}

export async function loadFonts(texts, specs) {
  const all = texts.filter(Boolean).join('');
  await Promise.all(specs.map((f) => document.fonts.load(f, all + 'ABCabc0123456789★·—→#').catch(() => null)));
}


export async function loadAssets(model, planTiles, onProgress = () => {}, { fontSpecs = [], accent = null } = {}) {
  const tasks = { total: 0, done: 0 };
  const tick = () => { tasks.done++; onProgress(tasks.done / Math.max(1, tasks.total)); };

  // every review card's own photos first, then the best of the rest
  const seen = new Set();
  const photoList = [];
  for (const q of model.quotes) for (const url of [q.photo, q.photo2]) if (url && !seen.has(url)) { seen.add(url); photoList.push({ url, weight: 50, from: 'review' }); }
  for (const p of model.photos) { if (photoList.length >= 30) break; if (!seen.has(p.url)) { seen.add(p.url); photoList.push(p); } }
  const avatarList = model.quotes.map((q) => q.avatar);
  const tileKeys = planTiles(model);
  tasks.total = photoList.length + avatarList.length + tileKeys.length + 1;

  const fontsP = loadFonts([
    model.place.title, model.place.category, model.place.address, model.place.city, model.place.state,
    ...model.quotes.map((q) => q.text + q.name + q.when),
    ...model.keywords.map((k) => k.word), ...model.subRatings.map((s) => s.label),
    ...model.facts.map((f) => f.label + f.value), model.headline || '',
  ], fontSpecs).then(tick);

  const photosP = pool(photoList, 8, async (p) => {
    const bmp = await loadBitmap(p.url);
    tick();
    return { ...p, bmp, stats: analyse(bmp) };
  });
  const avatarsP = pool(avatarList, 4, async (u) => {
    if (!u) { tick(); return null; }
    const b = await loadBitmap(u, 8000); tick(); return b;
  });
  const tiles = new Map();
  const tilesP = pool(tileKeys, 12, async ([z, x, y]) => {
    try { tiles.set(`${z}/${x}/${y}`, await loadBitmap(TILE_URL(z, x, y), 10000)); } finally { tick(); }
  });

  const [photosRaw, avatars] = await Promise.all([photosP, avatarsP, tilesP, fontsP]);
  const photos = photosRaw.filter(Boolean).filter((p) => p.bmp.width >= 200);
  if (!photos.length) throw new Error('None of the photos could be loaded');
  const byUrl = new Map(photos.map((p) => [p.url, p]));
  return {
    photos,
    byUrl,
    avatars,
    tiles,
    palette: pickPalette(photos, model.place.category, accent),
  };
}

// Fetch any tiles not yet in the map (used when the director swaps opener/outro).
export async function loadMoreTiles(assets, keys, onProgress = () => {}) {
  const missing = keys.filter(([z, x, y]) => !assets.tiles.has(`${z}/${x}/${y}`));
  let done = 0;
  await pool(missing, 12, async ([z, x, y]) => {
    try { assets.tiles.set(`${z}/${x}/${y}`, await loadBitmap(TILE_URL(z, x, y), 10000)); } finally { onProgress(++done / missing.length); }
  });
  return missing.length;
}
