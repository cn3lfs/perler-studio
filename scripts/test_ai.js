'use strict';
/* Checks source/ai.js under Node without any network access: node scripts/test_ai.js */
const assert = require('assert');
const AI = require('../source/ai.js');

const image = 'data:image/jpeg;base64,AAAA';
const candidates = [
 { code: 'H7', hex: '#000000', cells: 900 }, { code: 'H16', hex: '#1D1414', cells: 400 }, { code: 'H2', hex: '#FEFFFF', cells: 700 },
 { code: 'H13', hex: '#F5ECD2', cells: 2000 }, { code: 'E6', hex: '#F13D74', cells: 300 }, { code: 'A8', hex: '#FFDA45', cells: 200 }
];
const payload = { imageDataUrl: image, candidates, maxColors: 5, cols: 52, rows: 52 };
const config = { apiKey: ' sk-test ' };

// Request: DeepSeek defaults, key only in the Authorization header, image and candidates in the user turn.
const request = AI.buildRequest(config, payload);
assert.strictEqual(request.url, 'https://api.deepseek.com/chat/completions');
assert.strictEqual(request.headers.Authorization, 'Bearer sk-test');
assert.strictEqual(request.body.model, 'deepseek-flash');
assert.deepStrictEqual(request.body.response_format, { type: 'json_object' });
assert.strictEqual(request.body.thinking, undefined, 'default (careful) leaves DeepSeek thinking on');
assert.deepStrictEqual(AI.buildRequest({ ...config, effort: 'fast' }, payload).body.thinking, { type: 'disabled' }, 'fast mode turns DeepSeek thinking off');
assert(!JSON.stringify(request.body).includes('sk-test'), 'the key must not appear in the request body');
const [text, picture] = request.body.messages[1].content;
assert(text.text.includes('"max_colors":5') && text.text.includes('"code":"H13"') && picture.image_url.url === image);
assert(/JSON/.test(request.body.messages[0].content), 'JSON mode requires the word JSON in the prompt');

// Other providers get no vendor-specific field even in fast mode; base URLs are normalised.
const other = AI.buildRequest({ apiKey: 'k', baseUrl: 'https://example.com/v1/', model: 'vision-x', effort: 'fast' }, payload);
assert.strictEqual(other.url, 'https://example.com/v1/chat/completions');
assert.strictEqual(other.body.thinking, undefined);
assert.strictEqual(other.body.model, 'vision-x');
assert.strictEqual(AI.buildRequest({ apiKey: 'k', baseUrl: 'https://example.com/v1/chat/completions' }, payload).url, 'https://example.com/v1/chat/completions');
assert.strictEqual(AI.buildRequest({ apiKey: 'k', baseUrl: 'https://notdeepseek.com', effort: 'fast' }, payload).body.thinking, undefined);

// Unlimited colours become a bounded ceiling; only the top candidates are offered.
assert(AI.buildRequest(config, { ...payload, maxColors: 0 }).body.messages[1].content[0].text.includes('"max_colors":6'));
const many = Array.from({ length: 80 }, (_, i) => ({ code: 'X' + i, hex: '#000000', cells: 80 - i }));
assert.strictEqual(AI.buildRequest(config, { ...payload, candidates: many }).offered.length, AI.MAX_CANDIDATES);

// Bad input is refused before anything is sent.
assert.throws(() => AI.buildRequest({ apiKey: '  ' }, payload), /API Key/);
assert.throws(() => AI.buildRequest(config, { ...payload, imageDataUrl: 'https://example.com/a.png' }), /缩略图/);
assert.throws(() => AI.buildRequest({ apiKey: 'k', baseUrl: 'ftp://x' }, payload), /Base URL/);
assert.throws(() => AI.buildRequest(config, { ...payload, candidates: [] }), /候选色/);

// Reply validation: unknown codes dropped, duplicates removed, enums defaulted, lengths capped.
const offered = candidates.map(c => c.code);
const advice = AI.parseAdvice(JSON.stringify({
 subject: 'x'.repeat(200), sampling: 'weird', background: 'unify', background_code: 'h13', reserve_background: true, cleanup: 'strong',
 palette: ['h7', 'H7', 'ZZ9', 'E6', 'A8'], warnings: ['a', '', 'b\nc', 'd', 'e']
}), offered, 5);
assert.deepStrictEqual(advice.palette, ['H7', 'E6', 'A8', 'H13'], 'background bead is added to the palette');
assert.strictEqual(advice.backgroundCode, 'H13');
assert.strictEqual(advice.reserveBackground, true);
assert.strictEqual(advice.sampling, 'dominant');
assert.strictEqual(advice.cleanup, 'strong');
assert.strictEqual(advice.subject.length, 80);
assert.deepStrictEqual(advice.warnings, ['a', 'b c', 'd']);

// A background code that was not offered falls back to "keep"; missing cleanup means light.
const loose = AI.parseAdvice('```json\n{"palette":["H7","H2"],"background":"unify","background_code":"Q1","reserve_background":true}\n```', offered, 5);
assert.strictEqual(loose.background, 'keep');
assert.strictEqual(loose.backgroundCode, null);
assert.strictEqual(loose.reserveBackground, false);
assert.strictEqual(loose.cleanup, 'light');
assert.strictEqual(AI.parseAdvice('{"palette":["H7","H2"],"background":"empty"}', offered, 5).background, 'empty');
assert.strictEqual(AI.parseAdvice('{"palette":["H7","H2","E6","A8","H13","H16"]}', offered, 3).palette.length, 3, 'never more than max colours');

for (const bad of ['not json', '[]', '{"palette":["H7"]}', '{"palette":["ZZ1","ZZ2"]}', '{"palette":"H7,H2"}']) assert.throws(() => AI.parseAdvice(bad, offered, 5), /AI/, bad);

// Near-identical beads: the one with fewer first-pass cells goes; the background bead is exempt both ways.
const near = { H7: { H16: 7.4 }, H2: { H13: 5 } };
const distance = (a, b) => (near[a] && near[a][b]) || (near[b] && near[b][a]) || 50;
const base = { palette: ['H16', 'H7', 'H2', 'H13', 'E6'], backgroundCode: 'H13' };
assert.deepStrictEqual(AI.dedupe(base, { candidates, distance }).palette, ['H7', 'H2', 'H13', 'E6']);
assert.deepStrictEqual(AI.dedupe({ ...base, backgroundCode: null }, { candidates, distance }).palette, ['H7', 'H13', 'E6'], 'without a background the rarer white goes');
assert.deepStrictEqual(AI.dedupe(base, { candidates }).palette, base.palette, 'no distance function, no change');

// advise(): happy path with an injected fetch, then every failure the user can hit.
const reply = body => ({ ok: true, status: 200, json: async () => body });
const good = { choices: [{ message: { content: JSON.stringify({ subject: '猫', sampling: 'dominant', background: 'empty', cleanup: 'light', palette: ['H7', 'H16', 'E6'], warnings: [] }) } }] };
(async () => {
 let seen;
 const result = await AI.advise(config, { ...payload, distance }, async (url, init) => { seen = { url, init }; return reply(good); });
 assert.deepStrictEqual(result.palette, ['H7', 'E6'], 'advise applies dedupe');
 assert.strictEqual(seen.init.method, 'POST');
 assert.strictEqual(JSON.parse(seen.init.body).model, 'deepseek-flash');
 const fails = async (fetchImpl, pattern) => assert.rejects(AI.advise(config, payload, fetchImpl), pattern);
 await fails(async () => { throw new TypeError('network'); }, /连不上/);
 await fails(async () => ({ ok: false, status: 401 }), /401.*Key 无效/);
 await fails(async () => ({ ok: false, status: 402 }), /余额不足/);
 await fails(async () => ({ ok: false, status: 400 }), /不支持图片/);
 await fails(async () => ({ ok: false, status: 503 }), /503/);
 await fails(async () => reply({ choices: [] }), /没有返回内容/);
 await fails(async () => reply({ choices: [{ message: { content: 'sorry' } }] }), /JSON/);
 console.log('ai: all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
