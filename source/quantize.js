'use strict';
/** 格序 image-to-bead quantization. Pure functions, no DOM access, so it also runs under Node for tests.
 * Input is one RGB sample per grid cell; output is one palette code (or null) per cell.
 */
(function (root) {
 const hexRgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));

 function rgbToLab(rgb) {
  const [r, g, b] = rgb.map(v => { v /= 255; return v > .04045 ? ((v + .055) / 1.055) ** 2.4 : v / 12.92; });
  const f = [(r * .4124564 + g * .3575761 + b * .1804375) / .95047, r * .2126729 + g * .7151522 + b * .072175, (r * .0193339 + g * .119192 + b * .9503041) / 1.08883]
   .map(v => v > .008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  return [116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])];
 }

 const RAD = Math.PI / 180, POW25_7 = 25 ** 7;
 const hue = (b, a) => { if (!a && !b) return 0; const d = Math.atan2(b, a) / RAD; return d < 0 ? d + 360 : d; };

 /** CIEDE2000 colour difference between two Lab triples. */
 function deltaE00(x, y) {
  const [L1, a1, b1] = x, [L2, a2, b2] = y;
  const cb = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const G = .5 * (1 - Math.sqrt(cb ** 7 / (cb ** 7 + POW25_7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1 = Math.hypot(a1p, b1), C2 = Math.hypot(a2p, b2);
  const h1 = hue(b1, a1p), h2 = hue(b2, a2p), chromatic = C1 * C2 !== 0;
  let dh = 0;
  if (chromatic) { dh = h2 - h1; if (dh > 180) dh -= 360; else if (dh < -180) dh += 360; }
  const dL = L2 - L1, dC = C2 - C1, dH = 2 * Math.sqrt(C1 * C2) * Math.sin(dh * RAD / 2);
  const Lm = (L1 + L2) / 2, Cm = (C1 + C2) / 2;
  let hm = h1 + h2;
  if (chromatic) hm = Math.abs(h1 - h2) <= 180 ? hm / 2 : (hm < 360 ? (hm + 360) / 2 : (hm - 360) / 2);
  const T = 1 - .17 * Math.cos((hm - 30) * RAD) + .24 * Math.cos(2 * hm * RAD) + .32 * Math.cos((3 * hm + 6) * RAD) - .20 * Math.cos((4 * hm - 63) * RAD);
  const Sl = 1 + .015 * (Lm - 50) ** 2 / Math.sqrt(20 + (Lm - 50) ** 2), Sc = 1 + .045 * Cm, Sh = 1 + .015 * Cm * T;
  const Rt = -Math.sin(2 * 30 * Math.exp(-(((hm - 275) / 25) ** 2)) * RAD) * 2 * Math.sqrt(Cm ** 7 / (Cm ** 7 + POW25_7));
  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
 }

 /** A lone cell is merged into its surroundings only when the two colours are this close (ΔE00). */
 const SPECKLE_DELTA = 12;
 /** Share of the quantization error that dithering passes on; below 1 keeps flat areas calmer. */
 const DITHER_STRENGTH = .75;

 /**
  * @param {(number[]|null)[]} samples one [r,g,b] per cell, row-major; null = transparent
  * @param {{code:string,hex:string}[]} palette candidate beads
  * @param {{limit?:number,dither?:boolean,despeckle?:boolean,mask?:ArrayLike<number>}} options
  *   limit: maximum number of bead colours (0 = unlimited); mask[i] truthy = leave cell i empty
  * @returns {(string|null)[]}
  */
 function quantize(samples, cols, rows, palette, options = {}) {
  const { limit = 0, dither = false, despeckle = true, mask = null } = options;
  const n = cols * rows;
  if (samples.length !== n) throw Error('Sample count does not match the grid.');
  if (!palette.length) throw Error('Palette is empty.');
  const rgbs = palette.map(c => hexRgb(c.hex)), labs = rgbs.map(rgbToLab);
  const active = i => !!samples[i] && !(mask && mask[i]);
  const pairCache = new Map();
  const pair = (u, v) => { const key = u < v ? u * 4096 + v : v * 4096 + u; let d = pairCache.get(key); if (d === undefined) { d = deltaE00(labs[u], labs[v]); pairCache.set(key, d); } return d; };
  let allowed = palette.map((_, i) => i), cache = new Map();
  const nearest = rgb => {
   const key = rgb[0] << 16 | rgb[1] << 8 | rgb[2];
   let best = cache.get(key);
   if (best !== undefined) return best;
   const lab = rgbToLab(rgb);
   let score = Infinity;
   for (const k of allowed) { const d = deltaE00(lab, labs[k]); if (d < score) { score = d; best = k; } }
   cache.set(key, best);
   return best;
  };
  const clamp = v => Math.max(0, Math.min(255, Math.round(v)));
  const index = new Int16Array(n).fill(-1);
  const mapAll = () => { for (let i = 0; i < n; i++) index[i] = active(i) ? nearest(samples[i].map(clamp)) : -1; };
  mapAll();

  if (limit > 0) {
   const count = new Map();
   for (const k of index) if (k >= 0) count.set(k, (count.get(k) || 0) + 1);
   // Drop the colour whose beads are cheapest to move: few beads and a close substitute already in use.
   while (count.size > limit) {
    let victim = -1, target = -1, best = Infinity;
    for (const [u, beads] of count) {
     let near = -1, d = Infinity;
     for (const v of count.keys()) if (v !== u) { const e = pair(u, v); if (e < d) { d = e; near = v; } }
     if (beads * d < best) { best = beads * d; victim = u; target = near; }
    }
    count.set(target, count.get(target) + count.get(victim));
    count.delete(victim);
   }
   allowed = [...count.keys()];
   cache = new Map();
   mapAll();
  }

  if (dither) {
   // Floyd–Steinberg error diffusion inside the already chosen colour set.
   const buffer = Array.from({ length: n }, (_, i) => active(i) ? samples[i].slice(0, 3) : null);
   const spread = (x, y, error, weight) => {
    if (x < 0 || x >= cols || y >= rows) return;
    const cell = buffer[y * cols + x];
    if (cell) for (let k = 0; k < 3; k++) cell[k] += error[k] * weight;
   };
   for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const i = y * cols + x;
    if (!buffer[i]) continue;
    const wanted = buffer[i].map(clamp), k = nearest(wanted);
    index[i] = k;
    const error = wanted.map((v, c) => (v - rgbs[k][c]) * DITHER_STRENGTH);
    spread(x + 1, y, error, 7 / 16); spread(x - 1, y + 1, error, 3 / 16); spread(x, y + 1, error, 5 / 16); spread(x + 1, y + 1, error, 1 / 16);
   }
  } else if (despeckle) {
   // Replace a cell that has no same-coloured 4-neighbour by the colour around it, but only when the
   // two are near-identical; high-contrast single beads (eye highlights, dots) are kept.
   const source = index.slice();
   for (let i = 0; i < n; i++) {
    const own = source[i];
    if (own < 0) continue;
    const x = i % cols, y = (i - x) / cols, tally = new Map();
    let same = false;
    for (const j of [x > 0 ? i - 1 : -1, x + 1 < cols ? i + 1 : -1, y > 0 ? i - cols : -1, y + 1 < rows ? i + cols : -1]) {
     if (j < 0 || source[j] < 0) continue;
     if (source[j] === own) { same = true; break; }
     tally.set(source[j], (tally.get(source[j]) || 0) + 1);
    }
    if (same || !tally.size) continue;
    const [k, votes] = [...tally].sort((a, b) => b[1] - a[1])[0];
    if (votes >= 2 && pair(own, k) <= SPECKLE_DELTA) index[i] = k;
   }
  }
  return Array.from(index, k => k < 0 ? null : palette[k].code);
 }

 const api = { hexRgb, rgbToLab, deltaE00, quantize };
 if (typeof module !== 'undefined' && module.exports) module.exports = api;
 root.BeadQuantize = api;
})(typeof window !== 'undefined' ? window : globalThis);
