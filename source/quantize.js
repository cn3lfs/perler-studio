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
 /** Edge blur: neighbours must differ by at least this much (RGB distance) to count as two colours. */
 const EDGE_MIN_CONTRAST = 70;
 /** Edge blur: the cell may sit at most this far (RGB distance) off the line between its neighbours. */
 const EDGE_OFF_LINE = 28;
 /** Edge blur: only mixes holding at least this share of each neighbour are treated as blur. */
 const EDGE_MIX_RANGE = .15;
 /** Background specks may be this many times further from the backdrop colour than the flood tolerance. */
 const SPECK_TOLERANCE = 3;
 /** Strong cleanup: how many of the 8 neighbours must agree before an isolated bead is replaced. */
 const STRONG_VOTES = 6;
 /** Share of the quantization error that dithering passes on; below 1 keeps flat areas calmer. */
 const DITHER_STRENGTH = .75;

 /**
  * @param {(number[]|null)[]} samples one [r,g,b] per cell, row-major; null = transparent
  * @param {{code:string,hex:string}[]} palette candidate beads
  * @param {{limit?:number,dither?:boolean,cleanup?:'none'|'light'|'strong',despeckle?:boolean,mask?:ArrayLike<number>,maskCode?:string,maskExclusive?:boolean}} options
  *   limit: maximum number of bead colours (0 = unlimited)
  *   cleanup: 'light' merges near-identical lone beads; 'strong' also removes every isolated single bead
  *     (despeckle:true/false is the older spelling of 'light'/'none')
  *   mask[i] truthy = background cell: left empty, or given maskCode when one is supplied
  *   maskExclusive: the maskCode bead is used for background cells only, never inside the subject
  * @returns {(string|null)[]}
  */
 function quantize(samples, cols, rows, palette, options = {}) {
  const { limit = 0, dither = false, mask = null, maskCode = null } = options;
  const cleanup = options.cleanup || (options.despeckle === false ? 'none' : 'light');
  if (maskCode && !palette.some(c => c.code === maskCode)) throw Error('Background bead is not in the palette.');
  const n = cols * rows;
  if (samples.length !== n) throw Error('Sample count does not match the grid.');
  if (!palette.length) throw Error('Palette is empty.');
  const rgbs = palette.map(c => hexRgb(c.hex)), labs = rgbs.map(rgbToLab);
  const active = i => !!samples[i] && !(mask && mask[i]);
  const pairCache = new Map();
  const pair = (u, v) => { const key = u < v ? u * 4096 + v : v * 4096 + u; let d = pairCache.get(key); if (d === undefined) { d = deltaE00(labs[u], labs[v]); pairCache.set(key, d); } return d; };
  const fill = maskCode ? palette.findIndex(c => c.code === maskCode) : -1;
  let allowed = palette.map((_, i) => i), cache = new Map();
  if (options.maskExclusive && fill >= 0 && palette.length > 1) allowed = allowed.filter(k => k !== fill);
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
  } else if (cleanup !== 'none') {
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
   if (cleanup === 'strong') {
    // Flat-colour art: a bead with no same-coloured bead among its 8 neighbours, sitting in a field that is
    // almost entirely one other colour, is a highlight or edge-blur sample. Two passes also clear pairs.
    for (let pass = 0; pass < 2; pass++) {
     const before = index.slice();
     for (let i = 0; i < n; i++) {
      const own = before[i];
      if (own < 0) continue;
      const x = i % cols, y = (i - x) / cols, tally = new Map();
      let same = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
       if ((!dx && !dy) || x + dx < 0 || x + dx >= cols || y + dy < 0 || y + dy >= rows) continue;
       const k = before[(y + dy) * cols + x + dx];
       if (k < 0) continue;
       if (k === own) same++; else tally.set(k, (tally.get(k) || 0) + 1);
      }
      if (same > (pass ? 1 : 0) || !tally.size) continue;
      const [k, votes] = [...tally].sort((a, b) => b[1] - a[1])[0];
      if (votes >= STRONG_VOTES) index[i] = k;
     }
    }
   }
  }
  if (fill >= 0) for (let i = 0; i < n; i++) if (samples[i] && mask && mask[i]) index[i] = fill;
  return Array.from(index, k => k < 0 ? null : palette[k].code);
 }

 /**
  * Cells that belong to the backdrop: starting from the most common colour along the frame, spread inwards
  * over 4-connected cells whose colour stays within `tolerance` (ΔE76) of it. Transparent cells count too.
  * @returns {{mask:Uint8Array, rgb:number[]|null}} rgb = median backdrop colour, null when there is none
  */
 function backgroundMask(samples, cols, rows, tolerance) {
  const n = cols * rows, mask = new Uint8Array(n), labs = samples.map(s => s ? rgbToLab(s) : null);
  const onEdge = i => { const x = i % cols, y = (i - x) / cols; return x === 0 || y === 0 || x === cols - 1 || y === rows - 1; };
  const bins = new Map();
  for (let i = 0; i < n; i++) if (samples[i] && onEdge(i)) { const key = samples[i].map(v => Math.round(v / 16)).join(); (bins.get(key) || bins.set(key, []).get(key)).push(i); }
  if (!bins.size) return { mask, rgb: null };
  const dominant = [...bins.values()].sort((a, b) => b.length - a.length)[0];
  const rgb = [0, 1, 2].map(k => dominant.map(i => samples[i][k]).sort((a, b) => a - b)[dominant.length >> 1]);
  const centre = rgbToLab(rgb), limit = tolerance ** 2;
  const near = i => !labs[i] || (labs[i][0] - centre[0]) ** 2 + (labs[i][1] - centre[1]) ** 2 + (labs[i][2] - centre[2]) ** 2 <= limit;
  const queue = [];
  for (let i = 0; i < n; i++) if (onEdge(i) && near(i)) { mask[i] = 1; queue.push(i); }
  for (let k = 0; k < queue.length; k++) {
   const i = queue[k], x = i % cols, y = (i - x) / cols;
   for (const j of [x > 0 ? i - 1 : -1, x + 1 < cols ? i + 1 : -1, y > 0 ? i - cols : -1, y + 1 < rows ? i + cols : -1]) if (j >= 0 && !mask[j] && near(j)) { mask[j] = 1; queue.push(j); }
  }
  // Textured backdrops (paper grain, a printed grid) leave specks that are a little too far off to be
  // reached above. A cell that is still roughly the backdrop colour and is hemmed in by background on at
  // least three sides belongs to it as well; repeating this clears specks and short stubs but stops at any
  // solid region, because cells inside one have at most two background neighbours.
  const loose = (tolerance * SPECK_TOLERANCE) ** 2;
  const roughly = i => !labs[i] || (labs[i][0] - centre[0]) ** 2 + (labs[i][1] - centre[1]) ** 2 + (labs[i][2] - centre[2]) ** 2 <= loose;
  for (let changed = true; changed;) {
   changed = false;
   for (let i = 0; i < n; i++) {
    if (mask[i] || !roughly(i)) continue;
    const x = i % cols, y = (i - x) / cols;
    const around = (x === 0 || mask[i - 1]) + (x === cols - 1 || mask[i + 1]) + (y === 0 || mask[i - cols]) + (y === rows - 1 || mask[i + cols]);
    if (around >= 3) { mask[i] = 1; changed = true; }
   }
  }
  return { mask, rgb };
 }

 /**
  * Undo edge blur. A cell sampled across the border of two flat colours gets a mix of both, which would
  * otherwise be matched to an unrelated third bead (grey between black and white, brown between black and
  * orange). When a cell's colour lies on the straight line between its two opposite neighbours, and those
  * neighbours clearly differ, the cell takes the colour of the nearer one. Works on RGB samples; returns a copy.
  */
 function sharpenEdges(samples, cols, rows) {
  const out = samples.slice(), dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  for (let i = 0; i < samples.length; i++) {
   const s = samples[i];
   if (!s) continue;
   const x = i % cols, y = (i - x) / cols;
   let best = null, bestOff = EDGE_OFF_LINE;
   for (const [a, b] of [[x > 0 ? samples[i - 1] : null, x + 1 < cols ? samples[i + 1] : null], [y > 0 ? samples[i - cols] : null, y + 1 < rows ? samples[i + cols] : null]]) {
    if (!a || !b) continue;
    const span = dist(a, b);
    if (span < EDGE_MIN_CONTRAST) continue;
    const t = ((s[0] - a[0]) * (b[0] - a[0]) + (s[1] - a[1]) * (b[1] - a[1]) + (s[2] - a[2]) * (b[2] - a[2])) / (span * span);
    if (t < EDGE_MIX_RANGE || t > 1 - EDGE_MIX_RANGE) continue;
    const off = dist(s, [0, 1, 2].map(k => a[k] + t * (b[k] - a[k])));
    if (off < bestOff) { bestOff = off; best = t < .5 ? a : b; }
   }
   if (best) out[i] = best.slice(0, 3);
  }
  return out;
 }

 /** The palette entry closest to an RGB colour. */
 function nearestCode(rgb, palette) {
  const lab = rgbToLab(rgb);
  let best = null, score = Infinity;
  for (const c of palette) { const d = deltaE00(lab, rgbToLab(hexRgb(c.hex))); if (d < score) { score = d; best = c.code; } }
  return best;
 }

 const api = { hexRgb, rgbToLab, deltaE00, quantize, backgroundMask, sharpenEdges, nearestCode };
 if (typeof module !== 'undefined' && module.exports) module.exports = api;
 root.BeadQuantize = api;
})(typeof window !== 'undefined' ? window : globalThis);
