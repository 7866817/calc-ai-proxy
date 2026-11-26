// Cloudflare Pages Function: no-key AI proxy for 小明计算器 AA 分账.
// POST {text, members} -> {headcount, items:[{name, expr, payer, parts}]}
// Uses Workers AI (env.AI), same extraction prompt as the calculator page.
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
    return {
      name: typeof it.name === 'string' && it.name.trim() ? it.name.trim() : '花费',
      expr: String(expr).trim(),
      payer: typeof it.payer === 'string' && it.payer.trim() ? it.payer.trim() : null,
      parts: Array.isArray(it.parts) && it.parts.length ? it.parts : ['*'],
    };
  }).filter(Boolean);
  if (!items.length) return null;
  return { headcount: typeof d.headcount === 'number' ? d.headcount : null, items };
}

export async function onRequest({ request, env }) {
  const origin = request.headers.get('Origin') || 'null';
  const headers = corsHeaders(origin);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  const reply = (data, status = 200) => Response.json(data, { status, headers });
  if (request.method !== 'POST') return reply({ error: '仅支持 POST' }, 405);
  if (!ALLOWED_ORIGINS.includes(origin)) return reply({ error: '不允许的来源' }, 403);
  const input = await request.json().catch(() => null);
  if (!input || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 1600) {
    return reply({ error: '输入限 1 至 1600 字' }, 400);
  }
  const members = Array.isArray(input.members) ? input.members.filter(function (n) { return typeof n === 'string' && n; }).slice(0, 30) : [];
  const sys = '你是 AA 分账记账助手。把用户描述的花费整理成 JSON，只输出 JSON，不要任何解释，不要 markdown。\n' +
    '格式：{"headcount": 总人数或null, "items": [{"name": "项目名", "expr": "金额算式", "payer": "付款人或null", "parts": ["参与分摊的人"]}]}\n' +
    '规则：\n1. expr 是字符串，只写数字和 + - * / ( )，保留用户写的算式，不要自己心算，例如 "200" 或 "1200/6"。\n' +
    '2. payer 是出钱的人；没说是谁就写 null。\n' +
    '3. parts 是分摊的人；大家一起、AA、所有人、或没说明时写 ["*"]；“除了X”就列出其余所有人的名字。\n' +
    '4. headcount 是文中提到的总人数（如“6个人AA”），没提到写 null。\n' +
    '5. 名字尽量沿用已有成员。已有成员：' + (members.length ? members.join('、') : '（暂无）');
  let data = null, aiFailed = false;
  for (const model of MODELS) {
    try {
      const result = await env.AI.run(model, { messages: [{ role: 'system', content: sys }, { role: 'user', content: input.text }], temperature: 0.1, max_tokens: 1000 });
      const text = extractText(result);
      const parsed = text ? extractJson(text) : null;
      const norm = parsed ? normalizeData(parsed) : null;
      if (norm) { data = norm; break; }
    } catch (e) { aiFailed = true; }
  }
  if (!data) return reply({ error: aiFailed ? 'AI 暂时不可用，请稍后重试' : '没有识别出花费，请换种说法' }, aiFailed ? 503 : 422);
  return reply(data);
}
