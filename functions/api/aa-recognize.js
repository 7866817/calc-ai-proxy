// Cloudflare Pages Function: no-key AI proxy for 小明计算器 AA 分账.
// POST {text, members} -> {headcount, title, items:[{name, expr, payer, parts}]}
// Key order (first that works wins):
//   1. Server-side Gemini key (secret GEMINI_KEY) -> gemini-3.5-flash-lite
//   2. Server-side Zhipu key (secret ZHIPU_KEY) -> glm-4.7-flash
//   3. Workers AI (env.AI, no key needed): qwen / gemma / llama
// Only callable from the calculator site (and the Android APK, Origin: null).
const MODELS = ['@cf/qwen/qwen3.8-27b', '@cf/google/gemma-4-26b-a4b-it', '@cf/meta/llama-3.1-8b-instruct-fast'];
const ALLOWED_ORIGINS = ['https://7866817.github.io', 'null'];

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : 'https://7866817.github.io',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  };
}

function extractJson(c) {
  c = String(c).replace(/```(?:json)?/gi, '');
  const i = c.indexOf('{'), j = c.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(c.slice(i, j + 1)); } catch (e) { return null; }
}

// Workers AI returns an OpenAI-style chat completion object:
// choices[0].message.content holds the text. Some models also (or only)
// expose result.response as a string or an object. Check in that order.
function extractText(result) {
  if (!result) return '';
  const ch = result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content;
  if (typeof ch === 'string' && ch.trim()) return ch.trim();
  if (typeof result.response === 'string' && result.response.trim()) return result.response.trim();
  if (result.response && typeof result.response === 'object') return JSON.stringify(result.response);
  if (typeof result.text === 'string' && result.text.trim()) return result.text.trim();
  return '';
}

// Models often emit expr as a number, or amount/total instead of expr.
// Coerce everything into the calculator's {name, expr, payer, parts} shape.
// Safe arithmetic evaluator (no eval/Function: Workers forbids code
// generation from strings). expr is pre-validated to digits and
// + - * / ( ) . and whitespace only.
function evalExpr(s) {
  var i = 0;
  function skipWs() { while (s[i] === ' ' || s[i] === '\t') i++; }
  function parseNum() {
    skipWs();
    var start = i;
    while (/[\d.]/.test(s[i] || '')) i++;
    if (i === start) return NaN;
    return parseFloat(s.slice(start, i));
  }
  function parseFactor() {
    skipWs();
    if (s[i] === '(') { i++; var v = parseAdd(); skipWs(); if (s[i] !== ')') return NaN; i++; return v; }
    if (s[i] === '-') { i++; return -parseFactor(); }
    if (s[i] === '+') { i++; return parseFactor(); }
    return parseNum();
  }
  function parseMul() {
    var v = parseFactor();
    for (;;) {
      skipWs();
      if (s[i] === '*') { i++; v *= parseFactor(); }
      else if (s[i] === '/') { i++; var d = parseFactor(); if (d === 0) return NaN; v /= d; }
      else break;
    }
    return v;
  }
  function parseAdd() {
    var v = parseMul();
    for (;;) {
      skipWs();
      if (s[i] === '+') { i++; v += parseMul(); }
      else if (s[i] === '-') { i++; v -= parseMul(); }
      else break;
    }
    return v;
  }
  var v = parseAdd();
  skipWs();
  return i === s.length ? v : NaN;
}

function normalizeData(d) {
  if (!d || !Array.isArray(d.items) || !d.items.length) return null;
  const items = d.items.map(function (it) {
    if (!it || typeof it !== 'object') return null;
    let expr = it.expr;
    if (typeof expr === 'number') expr = String(expr);
    if ((!expr || !String(expr).trim()) && typeof it.amount === 'number' && it.amount > 0) expr = String(it.amount);
    if ((!expr || !String(expr).trim()) && typeof it.total === 'number' && it.total > 0) expr = String(it.total);
    if ((!expr || !String(expr).trim()) && typeof it.price === 'number' && it.price > 0) expr = String(it.price);
    if (!expr || !String(expr).trim()) return null;
    // expr must be a numeric expression (digits and + - * / ( ) only)
    // that evaluates to a positive number; anything else (model echoing
    // the input text, "待定", ...) is not an amount.
    expr = String(expr).trim();
    if (!/^[\d.+\-*/()\s]+$/.test(expr) || !/\d/.test(expr)) return null;
    var _v = evalExpr(expr);
    if (typeof _v !== 'number' || !isFinite(_v) || _v <= 0) return null;
    return {
      name: typeof it.name === 'string' && it.name.trim() ? it.name.trim() : '花费',
      expr: String(expr).trim(),
      payer: typeof it.payer === 'string' && it.payer.trim() ? it.payer.trim() : null,
      parts: Array.isArray(it.parts) && it.parts.length ? it.parts : ['*'],
    };
  }).filter(Boolean);
  if (!items.length) return null;
  const title = typeof d.title === 'string' && d.title.trim() ? d.title.trim().slice(0, 20) : null;
  return { headcount: typeof d.headcount === 'number' ? d.headcount : null, title, items };
}

// Returns {data} on success or {fail} with a short reason (never the key):
// http-<status>, timeout, network, bad-json, empty.
async function callOpenAI(base, model, key, sys, text) {
  key = String(key).trim();
  // Gemini keys start with AIza... (39 chars) or AQ.... (newer format).
  // A pasted masked display (AIza...xxxx) fails this check without ever
  // revealing the value.
  if (/generativelanguage/.test(base) && !/^(AIza|AQ\.)[0-9A-Za-z_-]{20,}$/.test(key)) return { fail: 'bad-key-format(len=' + key.length + ',prefix=' + key.slice(0, 4) + ')' };
  const body = { model, temperature: 0.1, messages: [{ role: 'system', content: sys }, { role: 'user', content: text }] };
  if (/bigmodel\.cn/.test(base)) body.thinking = { type: 'disabled' };
  const ctl = new AbortController(), timer = setTimeout(function () { ctl.abort(); }, 15000);
  try {
    const r = await fetch(base + '/chat/completions', {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(function () { return null; });
    if (!r.ok) {
      const msg = j && j.error && (j.error.message || j.error.code);
      return { fail: 'http-' + r.status + (msg ? ':' + String(msg).slice(0, 80) : '') };
    }
    if (!j) return { fail: 'bad-json' };
    const c = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!c) return { fail: 'empty' };
    const parsed = extractJson(c);
    const norm = parsed ? normalizeData(parsed) : null;
    return norm ? { data: norm } : { fail: 'bad-json' };
  } catch (e) { return { fail: e && e.name === 'AbortError' ? 'timeout' : 'network' }; } finally { clearTimeout(timer); }
}

export async function onRequest({ request, env }) {
  const origin = request.headers.get('Origin') || 'null';
  const headers = corsHeaders(origin);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  const reply = (data, status = 200, via) => Response.json(data, { status, headers: via ? Object.assign({}, headers, { 'X-AI-Via': via }) : headers });
  if (request.method !== 'POST') return reply({ error: '仅支持 POST' }, 405);
  if (!ALLOWED_ORIGINS.includes(origin)) return reply({ error: '不允许的来源' }, 403);
  const input = await request.json().catch(() => null);
  if (!input || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 1600) {
    return reply({ error: '输入限 1 至 1600 字' }, 400);
  }
  const members = Array.isArray(input.members) ? input.members.filter(function (n) { return typeof n === 'string' && n; }).slice(0, 30) : [];
  // No digits and no Chinese numerals -> no amount to recognize. Fail fast
  // instead of burning every backend (a no-amount input turns into a
  // scary 503 whenever Workers AI is rate-limited).
  if (!/[\d零一二三四五六七八九十百千萬万两]/.test(input.text)) {
    return reply({ error: '没有识别出花费，请换种说法' }, 422);
  }
  const sys = '你是 AA 分账记账助手。把用户描述的花费整理成 JSON，只输出 JSON，不要任何解释，不要 markdown。\n' +
    '格式：{"title": "简短标题或null", "headcount": 总人数或null, "items": [{"name": "项目名", "expr": "金额算式", "payer": "付款人或null", "parts": ["参与分摊的人"]}]}\n' +
    '规则：\n1. expr 是字符串，只写数字和 + - * / ( )，保留用户写的算式，不要自己心算，例如 "200" 或 "1200/6"。\n' +
    '2. payer 是出钱的人；没说是谁就写 null。\n' +
    '3. parts 是分摊的人；大家一起、AA、所有人、或没说明时写 ["*"]；“除了X”就列出其余所有人的名字。\n' +
    '4. headcount 是文中提到的总人数（如“6个人AA”），没提到写 null。\n' +
    '5. 名字尽量沿用已有成员。已有成员：' + (members.length ? members.join('、') : '（暂无）') + '\n' +
    '6. title 是这笔分账的简短标题（不超过10个字），根据内容起，比如“火锅”、“周六聚餐”、“大理旅行”；没有明确主题写 null。';
  // Accept any of the common variable names (dashboard entry may be
  // ZHIPU_KEY, ZHIPU_API_KEY or zhipu; same for Gemini).
  const zhipuKey = env.ZHIPU_KEY || env.ZHIPU_API_KEY || env.zhipu;
  const geminiKey = env.GEMINI_KEY || env.GEMINI_API_KEY || env.gemini;
  let data = null, aiFailed = false, via = null;
  const fails = {};
  // 1. Server-side Gemini key
  if (geminiKey) {
    const r1 = await callOpenAI('https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-3.5-flash-lite', geminiKey, sys, input.text);
    if (r1.data) { data = r1.data; via = 'gemini'; } else fails.gemini = r1.fail;
  }
  // 2. Server-side Zhipu key
  if (!data && zhipuKey) {
    const r2 = await callOpenAI('https://open.bigmodel.cn/api/paas/v4', 'glm-4.7-flash', zhipuKey, sys, input.text);
    if (r2.data) { data = r2.data; via = 'zhipu'; } else fails.zhipu = r2.fail;
  }
  // 3. Workers AI (no key needed)
  if (!data) {
    for (const model of MODELS) {
      try {
        const result = await env.AI.run(model, { messages: [{ role: 'system', content: sys }, { role: 'user', content: input.text }], temperature: 0.1, max_tokens: 1000 });
        const text = extractText(result);
        const parsed = text ? extractJson(text) : null;
        const norm = parsed ? normalizeData(parsed) : null;
        if (norm) { data = norm; via = 'workers-ai:' + model; break; }
      } catch (e) { aiFailed = true; }
    }
  }
  if (!data) {
    const eh = {};
    if (fails.gemini) eh['X-AI-Gemini-Fail'] = fails.gemini;
    if (fails.zhipu) eh['X-AI-Zhipu-Fail'] = fails.zhipu;
    const status = aiFailed ? 503 : 422;
    return Response.json({ error: aiFailed ? 'AI 暂时不可用，请稍后重试' : '没有识别出花费，请换种说法' },
      { status, headers: Object.assign({}, headers, eh) });
  }
  const extra = {};
  if (fails.gemini) extra['X-AI-Gemini-Fail'] = fails.gemini;
  if (fails.zhipu) extra['X-AI-Zhipu-Fail'] = fails.zhipu;
  const h2 = via ? Object.assign({}, headers, { 'X-AI-Via': via }, extra) : headers;
  return Response.json(data, { status: 200, headers: h2 });
}
