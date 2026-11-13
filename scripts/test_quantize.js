'use strict';
/* Checks source/quantize.js under Node, no dependencies: node scripts/test_quantize.js */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { rgbToLab, deltaE00, quantize } = require('../source/quantize.js');

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

console.log('quantize: all checks passed');
