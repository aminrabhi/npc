// Local test doubles for Groq, Supabase and the BBC feed.
//
//   node tools/mock_backends.js 4010
//
// Nothing here is used in production. It exists so the API routes, the automatic
// persistence paths and the manual transcript save can be exercised end to end
// without real credentials.

import http from 'node:http';

const port = Number(process.argv[2] || 4010);

const tables = new Map();
const stats = { chat: 0, reads: 0, writes: 0, failures: 0 };

const PRIMARY_KEY = {
  village_npc_relationships: ['npc_id', 'other_id'],
  village_npc_memories: ['id'],
  village_conversations: ['id'],
  village_conversation_messages: ['id'],
  village_news: ['id'],
};

function table(name) {
  if (!tables.has(name)) tables.set(name, []);
  return tables.get(name);
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

const OPENING = [
  'Morning. You are up early too, then.',
  'I was just thinking about the tomatoes.',
  'You look like you have something on your mind.',
  'There you are. I have been meaning to ask you something.',
];
const REPLY = [
  'That is a fair point, I suppose.',
  'I never thought of it that way.',
  'I would not count on that, mind.',
  'You say that, but I have my doubts.',
  'Well, that is one way to look at it.',
];
const CLOSING = [
  'Right, I should get back to it. Good talking to you.',
  'Off you go then. Mind yourself.',
  'We will finish this another time.',
  'Enough of that. See you around.',
];

function lineFor(prompt) {
  const speaker = (prompt.match(/You are ([^.\n]+)\./) || [])[1] || 'Villager';
  const bank = /Say the first thing/.test(prompt) ? OPENING : /last thing you will say/.test(prompt) ? CLOSING : REPLY;
  const line = bank[stats.chat % bank.length];
  stats.chat += 1;
  // the speaker name is not part of the line: the simulation knows who is talking
  return `${line.replace(speaker, speaker)} `;
}

function postgrestQuery(url, rows) {
  let out = rows.slice();
  for (const [key, value] of url.searchParams) {
    if (['select', 'limit', 'order', 'on_conflict'].includes(key)) continue;
    if (value.startsWith('eq.')) {
      const target = value.slice(3);
      out = out.filter((row) => String(row[key]) === target);
    }
  }
  const order = url.searchParams.get('order');
  if (order) {
    const [column, direction] = order.split('.');
    out.sort((a, b) => {
      const av = a[column] === null || a[column] === undefined ? '' : String(a[column]);
      const bv = b[column] === null || b[column] === undefined ? '' : String(b[column]);
      return direction === 'desc' ? bv.localeCompare(av) : av.localeCompare(bv);
    });
  }
  const limit = Number(url.searchParams.get('limit'));
  if (Number.isFinite(limit) && limit > 0) out = out.slice(0, limit);
  return out;
}

function upsert(name, rows, prefer) {
  const pk = PRIMARY_KEY[name] || ['id'];
  const existing = table(name);
  const ignored = /ignore-duplicates/.test(prefer || '');
  const written = [];
  for (const row of rows) {
    const index = existing.findIndex((current) => pk.every((key) => String(current[key]) === String(row[key])));
    if (index >= 0) {
      if (ignored) continue;
      existing[index] = { ...existing[index], ...row };
      written.push(existing[index]);
    } else {
      existing.push({ ...row });
      written.push(row);
    }
    stats.writes += 1;
  }
  return written;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (url.pathname === '/_stats') {
    json(res, 200, { stats, tables: Object.fromEntries([...tables].map(([name, rows]) => [name, rows.length])) });
    return;
  }

  if (url.pathname === '/_reset') {
    tables.clear();
    stats.chat = 0;
    stats.writes = 0;
    json(res, 200, { ok: true });
    return;
  }

  if (url.pathname === '/openai/v1/chat/completions') {
    if (req.method !== 'POST') {
      json(res, 405, { error: { message: 'POST only' } });
      return;
    }
    if (process.env.MOCK_GROQ === 'rate_limit') {
      stats.failures += 1;
      json(res, 429, { error: { message: 'Rate limit reached for allam-2-7b', type: 'rate_limit_error' } }, { 'retry-after': '3' });
      return;
    }
    if (process.env.MOCK_GROQ === 'empty') {
      stats.failures += 1;
      json(res, 200, { id: 'x', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: '   ' }, finish_reason: 'stop' }] });
      return;
    }
    if (!body || body.model !== 'allam-2-7b') {
      stats.failures += 1;
      json(res, 404, { error: { message: `The model ${body && body.model} does not exist`, code: 'model_not_found' } });
      return;
    }
    // A model that will only talk about the village, used to prove village life is
    // accepted rather than filtered out.
    if (process.env.MOCK_GROQ === 'village') {
      stats.chat += 1;
      json(res, 200, {
        id: `chatcmpl_${stats.chat}`,
        object: 'chat.completion',
        model: 'allam-2-7b',
        choices: [{ index: 0, message: { role: 'assistant', content: 'The whole village was at the square today. The neighbours were out as well.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 320, completion_tokens: 12, total_tokens: 332 },
      });
      return;
    }

    const prompt = (body.messages || []).map((message) => message.content).join('\n');
    json(res, 200, {
      id: `chatcmpl_${stats.chat}`,
      object: 'chat.completion',
      model: 'allam-2-7b',
      choices: [{ index: 0, message: { role: 'assistant', content: lineFor(prompt) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 320, completion_tokens: 12, total_tokens: 332 },
    });
    return;
  }

  if (url.pathname === '/news/rss.xml') {
    res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
    res.end(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>BBC News</title>
  <item><title><![CDATA[Village wins regional gardening prize]]></title><description><![CDATA[The tomatoes were described as "exceptional".]]></description><link>https://www.bbc.co.uk/news/test-1?at_medium=RSS&amp;at_campaign=rss</link><pubDate>Wed, 04 Nov 2026 09:00:00 GMT</pubDate></item>
  <item><title>New chip promises cheaper phones</title><description>A technology story about a processor.</description><link>https://www.bbc.co.uk/news/test-2</link><pubDate>Wed, 04 Nov 2026 10:00:00 GMT</pubDate></item>
  <item><title>Scientists find a quieter species of bee</title><description>Researchers recorded the bee in a meadow.</description><link>https://www.bbc.co.uk/news/test-3</link><pubDate>Wed, 04 Nov 2026 11:00:00 GMT</pubDate></item>
</channel></rss>`);
    return;
  }

  if (url.pathname.startsWith('/rest/v1/')) {
    const name = url.pathname.slice('/rest/v1/'.length);
    if (req.method === 'GET') {
      stats.reads += 1;
      json(res, 200, postgrestQuery(url, table(name)));
      return;
    }
    if (req.method === 'POST') {
      const rows = Array.isArray(body) ? body : [body];
      const written = upsert(name, rows.filter(Boolean), req.headers.prefer);
      json(res, 201, written);
      return;
    }
    if (req.method === 'PATCH') {
      const rows = postgrestQuery(url, table(name));
      for (const row of rows) Object.assign(row, body);
      json(res, 200, rows);
      return;
    }
    json(res, 405, { message: 'unsupported' });
    return;
  }

  json(res, 404, { message: 'not found' });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock backends on http://127.0.0.1:${port}`);
});
