'use strict';
/** 格序 optional AI adviser. Talks to any OpenAI-compatible chat endpoint that accepts image input
 * (default: DeepSeek). The model never places beads: it only returns settings — which bead colours to
 * keep, how to treat the background, how hard to clean up — and the local algorithm does the conversion.
 * No DOM access, so request building and reply validation also run under Node for tests.
 */
(function (root) {
 const DEFAULTS = { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' };
 /** Kept beads closer than this (CIEDE2000) are the same colour to the eye; only one survives. */
 const DUPLICATE_DELTA = 8;
 const BACKGROUNDS = ['keep', 'unify', 'empty'], CLEANUPS = ['none', 'light', 'strong'], SAMPLINGS = ['dominant', 'average'];
 /** How many first-pass colours the model gets to choose from. */
 const MAX_CANDIDATES = 48;

 const SYSTEM = [
  'You help convert a picture into a fuse-bead (拼豆 / perler) pattern. A local program does the conversion;',
  'you only choose its settings. Reply with one JSON object and nothing else.',
  '',
  'You receive the picture and a list of candidate beads: the MARD colour codes that a first, unrestricted',
  'pass matched, each with its hex value and how many grid cells it got.',
  '',
  'Choose the beads to keep. Rules:',
  '- Use only codes from the candidate list.',
  '- Keep one bead per distinct colour a person would name in the picture (one black, one white, one main',
  '  pink ...). Near-identical shades of the same colour are sampling noise: keep the one closest to the true',
  '  colour, normally the one with the most cells, and drop the rest.',
  '- Glossy or 3D lettering and shapes: the gradients, highlights and shadow tints inside one letter or shape',
  '  are NOT separate colours. Keep exactly one bead for its face, so the letter comes out flat and readable.',
  '- Keep a second, clearly darker or lighter shade of a colour only for a separate flat area that a person',
  '  would point at (a drop shadow band, a darker ear), never for soft shading.',
  '- Colours that only appear as blur between two regions (greys, muddy browns, dark reds along outlines)',
  '  must be dropped.',
  '- Small but meaningful colours (eyes, blush, buttons) must be kept even when their cell count is low.',
  '- Where the subject has pure white areas, keep the whitest candidate for them, separate from a cream or',
  '  off-white backdrop.',
  '- Fewer is better. Flat cartoons and logos usually need 6 to 12 beads; max_colors is a ceiling, not a target.',
  '- Never exceed max_colors.',
  '',
  'JSON fields:',
  '"subject": what the picture shows, at most 12 words, in the language of any text in the picture, else Chinese.',
  '"sampling": "dominant" for cartoons, logos, pixel art and flat colours; "average" for photos and paintings.',
  '"background": "unify" when the subject sits on a plain or lightly textured backdrop that should become one',
  '  bead colour; "empty" when that backdrop should be left without beads (a cut-out sticker or charm);',
  '  "keep" when the whole picture is the artwork (scenery, photos).',
  '"background_code": for "unify", the candidate code for the backdrop; it must look different from any bead',
  '  kept for the subject\'s own light areas. Otherwise null.',
  '"reserve_background": true when the backdrop colour is not part of the subject itself, so that bead must',
  '  be used for the backdrop only; false when the same colour also fills areas of the subject. Only for "unify".',
  '"cleanup": "strong" for flat-colour art with outlines, "light" for detailed art, "none" for photos.',
  '"palette": array of kept codes, most important first.',
  '"warnings": array of at most 3 short sentences in Chinese about problems in the source that the user should',
  '  know, e.g. a printed grid that does not match its own labels, text too small for the grid, heavy gradients.',
  '  Empty array when there is nothing to say.'
 ].join('\n');

 function endpoint(baseUrl) {
  const base = String(baseUrl || DEFAULTS.baseUrl).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) throw Error('Base URL 需以 http:// 或 https:// 开头。');
  return /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
 }

 /** @param candidates [{code,hex,cells}] sorted by cells, descending */
 function buildRequest(config, { imageDataUrl, candidates, maxColors, cols, rows }) {
  if (!config || !String(config.apiKey || '').trim()) throw Error('请先填写 API Key。');
  if (!/^data:image\/(png|jpeg|webp);base64,/i.test(imageDataUrl || '')) throw Error('AI 需要一张缩略图。');
  const list = candidates.slice(0, MAX_CANDIDATES);
  if (!list.length) throw Error('没有可供选择的候选色。');
  const task = { grid: `${cols}x${rows}`, max_colors: maxColors > 0 ? maxColors : Math.min(24, list.length), candidates: list.map(c => ({ code: c.code, hex: c.hex, cells: c.cells })) };
  const body = {
   model: String(config.model || DEFAULTS.model).trim(),
   messages: [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: [{ type: 'text', text: 'Task (JSON):\n' + JSON.stringify(task) }, { type: 'image_url', image_url: { url: imageDataUrl } }] }
   ],
   response_format: { type: 'json_object' },
   temperature: 0
  };
  // DeepSeek thinks by default (20-60 s per call) and that is what gives reliable advice. "fast" turns
  // thinking off (about 3 s) at the cost of mistakes such as dropping a needed colour.
  // Other providers get no vendor-specific fields.
  if (config.effort === 'fast' && /(^|\.)deepseek\.com$/i.test(new URL(endpoint(config.baseUrl)).hostname)) body.thinking = { type: 'disabled' };
  return { url: endpoint(config.baseUrl), headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + String(config.apiKey).trim() }, body, maxColors: task.max_colors, offered: list.map(c => c.code) };
 }

 /** Validates a model reply against what was offered. Throws when it is unusable; never trusts free text. */
 function parseAdvice(text, offered, maxColors) {
  let data;
  try { data = JSON.parse(String(text).replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '')); } catch { throw Error('AI 返回的不是有效 JSON。'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('AI 返回的格式不对。');
  const allowed = new Set(offered), palette = [];
  for (const code of Array.isArray(data.palette) ? data.palette : []) { const c = String(code).trim().toUpperCase(); if (allowed.has(c) && !palette.includes(c)) palette.push(c); }
  if (palette.length < 2) throw Error('AI 没有给出可用的色号。');
  const pick = (value, options) => options.includes(value) ? value : options[0];
  let background = pick(data.background, BACKGROUNDS), backgroundCode = null;
  if (background === 'unify') {
   const code = String(data.background_code || '').trim().toUpperCase();
   if (allowed.has(code)) backgroundCode = code; else background = 'keep';
  }
  if (backgroundCode && !palette.includes(backgroundCode)) palette.push(backgroundCode);
  const clean = s => String(s).replace(/[\u0000-\u001f]/g, ' ').trim();
  return {
   subject: clean(data.subject || '').slice(0, 80),
   sampling: pick(data.sampling, SAMPLINGS),
   background, backgroundCode, reserveBackground: background === 'unify' && data.reserve_background === true,
   cleanup: pick(data.cleanup, ['light', 'none', 'strong']),
   palette: palette.slice(0, Math.max(2, maxColors)),
   warnings: (Array.isArray(data.warnings) ? data.warnings : []).map(clean).filter(Boolean).slice(0, 3).map(s => s.slice(0, 120))
  };
 }

 /** Sends the request and returns validated advice. `fetchImpl` is injectable for tests. */
 async function advise(config, payload, fetchImpl) {
  const request = buildRequest(config, payload), doFetch = fetchImpl || root.fetch;
  if (!doFetch) throw Error('当前环境无法发起网络请求。');
  let response;
  try { response = await doFetch(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(request.body) }); }
  catch { throw Error('连不上 AI 服务，请检查网络或 Base URL。'); }
  if (!response.ok) {
   const hint = { 400: '请求被拒绝，所选模型可能不支持图片输入', 401: 'API Key 无效', 402: '账户余额不足', 404: '接口或模型不存在', 429: '请求过于频繁' }[response.status] || '服务出错';
   throw Error(`AI 请求失败（${response.status}：${hint}）。`);
  }
  const data = await response.json(), text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (typeof text !== 'string' || !text.trim()) throw Error('AI 没有返回内容。');
  return dedupe(parseAdvice(text, request.offered, request.maxColors), payload);
 }

 /** Models often keep two beads of one colour (two blacks, two yellows). Of each near-identical pair the one
  * with fewer first-pass cells is dropped; the background bead is never dropped or merged into. */
 function dedupe(advice, { candidates, distance }) {
  if (typeof distance !== 'function') return advice;
  const cells = new Map(candidates.map(c => [c.code, c.cells])), kept = [];
  for (const code of [...advice.palette].sort((x, y) => (cells.get(y) || 0) - (cells.get(x) || 0))) {
   if (code === advice.backgroundCode || !kept.some(k => k !== advice.backgroundCode && distance(k, code) < DUPLICATE_DELTA)) kept.push(code);
  }
  return { ...advice, palette: advice.palette.filter(c => kept.includes(c)) };
 }

 const api = { DEFAULTS, MAX_CANDIDATES, DUPLICATE_DELTA, buildRequest, parseAdvice, dedupe, advise };
 if (typeof module !== 'undefined' && module.exports) module.exports = api;
 root.BeadAI = api;
})(typeof window !== 'undefined' ? window : globalThis);
