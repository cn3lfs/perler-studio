'use strict';
/* Checks source/quantize.js under Node, no dependencies: node scripts/test_quantize.js */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { rgbToLab, deltaE00, quantize, backgroundMask, sharpenEdges, nearestCode } = require('../source/quantize.js');

// Reference pairs from Sharma, Wu & Dalal, "The CIEDE2000 Color-Difference Formula" (2005), table 1.
for (const [a, b, expected] of [
 [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
 [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
 [[50, 2.8361, -74.02], [50, 0, -82.7485], 3.4412],
 [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0],
 [[50, 2.5, 0], [50, 0, -2.5], 4.3065],
 [[50, 2.5, 0], [73, 25, -18], 27.1492],
 [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
 [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082]
]) {
 assert(Math.abs(deltaE00(a, b) - expected) < 1e-4, `deltaE00 ${a} / ${b}: ${deltaE00(a, b)} != ${expected}`);
 assert(Math.abs(deltaE00(b, a) - expected) < 1e-4, 'deltaE00 must be symmetric');
}
const white = rgbToLab([255, 255, 255]);
assert(Math.abs(white[0] - 100) < .01 && Math.abs(white[1]) < .01 && Math.abs(white[2]) < .01, 'white must be L=100');

const data = fs.readFileSync(path.join(__dirname, '../source/data.js'), 'utf8');
const palette = JSON.parse(data.match(/const\s+BASE_PALETTE\s*=\s*(\[.*?\]);/s)[1]);
const hex = code => palette.find(c => c.code === code).hex;
const rgb = code => [1, 3, 5].map(i => parseInt(hex(code).slice(i, i + 2), 16));

// Exact palette colours map to themselves; null and masked cells stay empty.
const exact = quantize([rgb('A4'), rgb('C5'), null, rgb('F5')], 2, 2, palette, { mask: [0, 0, 0, 1] });
assert.deepStrictEqual(exact, ['A4', 'C5', null, null]);

// The colour limit is respected and keeps the dominant colours.
const noisy = [];
for (let i = 0; i < 400; i++) noisy.push(i % 40 === 0 ? [Math.random() * 255, Math.random() * 255, Math.random() * 255] : i % 2 ? rgb('A4') : rgb('C5'));
const limited = quantize(noisy, 20, 20, palette, { limit: 4, despeckle: false });
const usedLimited = new Set(limited);
assert(usedLimited.size <= 4 && usedLimited.has('A4') && usedLimited.has('C5'), 'limit must keep dominant colours');

// Despeckle merges a near-identical lone bead but keeps a high-contrast one.
const field = (center, around) => Array.from({ length: 25 }, (_, i) => i === 12 ? rgb(center) : rgb(around));
const closest = palette.filter(c => c.code !== 'H7').map(c => ({ code: c.code, d: deltaE00(rgbToLab(rgb(c.code)), rgbToLab(rgb('H7'))) })).sort((a, b) => a.d - b.d)[0];
assert(closest.d < 12, 'expected a near-black neighbour of H7 in the palette');
assert.strictEqual(quantize(field(closest.code, 'H7'), 5, 5, palette)[12], 'H7', 'similar speck must merge');
assert.strictEqual(quantize(field(closest.code, 'H7'), 5, 5, palette, { despeckle: false })[12], closest.code);
assert.strictEqual(quantize(field('H2', 'H7'), 5, 5, palette)[12], 'H2', 'contrasting bead must survive');

// Dithering a mid grey between two allowed beads uses both, in similar amounts.
const twoTone = [palette.find(c => c.code === 'H7'), palette.find(c => c.code === 'H2')];
const mid = rgb('H7').map((v, i) => Math.round((v + rgb('H2')[i]) / 2));
const dithered = quantize(Array(400).fill(mid), 20, 20, twoTone, { dither: true });
const dark = dithered.filter(c => c === 'H7').length;
assert(dark > 80 && dark < 320, 'dither should mix both beads, got ' + dark);
assert.strictEqual(new Set(quantize(Array(400).fill(mid), 20, 20, twoTone)).size, 1, 'without dither a flat field is one colour');

// Strong cleanup removes an isolated high-contrast bead that light cleanup keeps; a 2x2 block always survives.
assert.strictEqual(quantize(field('H2', 'H7'), 5, 5, palette, { cleanup: 'strong' })[12], 'H7', 'strong cleanup removes a lone bead');
const block = Array.from({ length: 36 }, (_, i) => [14, 15, 20, 21].includes(i) ? rgb('H2') : rgb('H7'));
assert.strictEqual(quantize(block, 6, 6, palette, { cleanup: 'strong' }).filter(c => c === 'H2').length, 4, 'strong cleanup keeps a 2x2 block');
assert.strictEqual(quantize(field('H2', 'H7'), 5, 5, palette, { cleanup: 'none' })[12], 'H2');

// Edge blur: a 50% mix between two contrasting neighbours snaps to one of them; a genuine third colour stays.
const ink = rgb('H7'), paper = rgb('H2'), mix = ink.map((v, i) => Math.round((v + paper[i]) / 2));
const row = sharpenEdges([ink, ink, mix, paper, paper], 5, 1);
assert(row[2].join() === ink.join() || row[2].join() === paper.join(), 'blend must snap to a neighbour');
assert.strictEqual(sharpenEdges([ink, ink, rgb('F5'), paper, paper], 5, 1)[2].join(), rgb('F5').join(), 'a real third colour must stay');
assert.strictEqual(sharpenEdges([ink, mix, null], 3, 1)[1].join(), mix.join(), 'no opposite neighbour, no change');

// Background: a cream frame around a framed subject is found from the edges and stops at the outline.
const W = 9, cream = [246, 240, 225], scene = Array.from({ length: W * W }, (_, i) => {
 const x = i % W, y = (i - x) / W, ring = Math.max(Math.abs(x - 4), Math.abs(y - 4));
 return ring === 4 || ring === 3 ? cream.map(v => v - (i % 3)) : ring === 2 ? ink : ring === 1 ? paper : cream;
});
const bg = backgroundMask(scene, W, W, 12);
assert.strictEqual(bg.mask.reduce((a, b) => a + b, 0), W * W - 25, 'mask covers the two outer rings only');
assert(Math.abs(bg.rgb[0] - cream[0]) <= 2, 'backdrop colour is the frame colour');
assert.strictEqual(backgroundMask([null, null, null, null], 2, 2, 12).rgb, null);
// Specks in the backdrop that are a bit too grey for the flood are absorbed; a contrasting dot is not.
const speckled = scene.slice(); speckled[10] = [214, 210, 200]; speckled[16] = [20, 20, 20];
const bg2 = backgroundMask(speckled, W, W, 12);
assert(bg2.mask[10] === 1 && bg2.mask[16] === 0, 'grey speck joins the background, black dot stays');
assert.strictEqual(bg2.mask.reduce((a, b) => a + b, 0), W * W - 26);
const beads = ['H7', 'H2', 'H13'].map(c => palette.find(p => p.code === c));
assert.strictEqual(nearestCode(bg.rgb, beads), 'H13');
// unify: every background cell gets the chosen bead; the enclosed cream centre keeps its own match ...
const unified = quantize(scene, W, W, beads, { mask: bg.mask, maskCode: 'H13', cleanup: 'none' });
assert(unified.every((c, i) => !bg.mask[i] || c === 'H13') && unified[40] === 'H13' && unified[0] === 'H13');
// ... unless the background bead is reserved, in which case the centre takes the next best bead.
const reserved = quantize(scene, W, W, beads, { mask: bg.mask, maskCode: 'H13', maskExclusive: true, cleanup: 'none' });
assert(reserved[40] === 'H2' && reserved[0] === 'H13' && reserved.filter(c => c === 'H13').length === W * W - 25);
// empty: background cells stay without beads.
assert.strictEqual(quantize(scene, W, W, beads, { mask: bg.mask, cleanup: 'none' }).filter(c => c === null).length, W * W - 25);
assert.throws(() => quantize(scene, W, W, beads, { mask: bg.mask, maskCode: 'A1' }), /Background bead/);

console.log('quantize: all checks passed');
