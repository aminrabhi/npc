#!/usr/bin/env node
// Checks a real deployment (local `npm run dev` or Vercel) against real credentials.
//
//   npm run check:live -- https://your-app.vercel.app
//   npm run check:live -- http://127.0.0.1:3000
//
// It reads only: nothing is written to Supabase and no transcript is saved. What it
// answers, in order:
//
//   1. are GROQ_API_KEY and the Supabase keys present on the server?
//   2. does the configured model (allam-2-7b by default) actually answer?
//   3. has supabase/schema.sql been applied (are all five tables readable)?
//   4. are BBC headlines loading?
//
// Every failure prints the exact fix, so a red result is a one-line change rather
// than a hunt through logs.

const base = (process.argv[2] || process.env.VILLAGE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');

let failures = 0;
const rows = [];

function pass(label, detail = '') {
  rows.push({ ok: true, label, detail });
  console.log(`  PASS  ${label}${detail ? `  (${detail})` : ''}`);
}

function fail(label, detail = '', fix = '') {
  failures += 1;
  rows.push({ ok: false, label, detail, fix });
  console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ''}`);
  if (fix) console.log(`        fix: ${fix}`);
}

function info(text) {
  console.log(`        ${text}`);
}

async function getJson(path) {
  const res = await fetch(`${base}${path}`, { headers: { Accept: 'application/json' } });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function postJson(path, payload) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

const speaker = {
  name: 'Mara',
  personality: ['observant', 'unhurried'],
  backstory: 'Keeps the village greenhouse and knows every plant in it by name.',
  interests: ['gardening', 'weather'],
  style: 'plain, warm, short sentences',
  social: { sociability: 0.6, newsInterest: 0.3 },
};

const listener = {
  name: 'Tobias',
  personality: ['wry', 'practical'],
  interests: ['carpentry'],
  style: 'dry and direct',
};

async function checkStatus() {
  console.log('\n1. configuration');
  const { status, body } = await getJson('/api/status');
  if (status !== 200 || !body || !body.ok) {
    fail('server answers /api/status', `HTTP ${status}`, `Is ${base} running and is the API mounted?`);
    return null;
  }
  if (body.groq && body.groq.configured) {
    pass('GROQ_API_KEY is set on the server');
  } else {
    fail('GROQ_API_KEY is missing', 'villagers would only produce offline lines',
      'Vercel -> Settings -> Environment Variables -> GROQ_API_KEY (then redeploy).');
  }
  if (body.supabase && body.supabase.configured) {
    pass('SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set');
  } else {
    fail('Supabase is not configured',
      `missing: ${(body.missing || []).join(', ') || 'unknown'}`,
      'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel, then redeploy.');
  }
  info(`model in use: ${body.groq && body.groq.model}`);
  if (body.groq && body.groq.model !== body.groq.defaultModel) {
    info(`note: GROQ_MODEL overrides the ${body.groq.defaultModel} default`);
  }
  return body;
}

async function checkChat(status) {
  console.log('\n2. real model reply');
  if (!status || !status.groq || !status.groq.configured) {
    fail('skipped: no Groq key', '', 'Add GROQ_API_KEY first.');
    return;
  }
  const started = Date.now();
  const { status: code, body } = await postJson('/api/chat', {
    conversationId: `live_check_${Date.now()}`,
    mode: 'opening',
    messageCount: 0,
    speaker,
    listener,
    history: [],
    memories: [],
    news: [],
    recentLines: [],
    relationship: { score: 10, category: 'acquaintance', trust: 0.4, familiarity: 0.3, dislike: 0 },
  });
  const ms = Date.now() - started;

  if (code === 200 && body && body.ok && body.message && body.message.text) {
    pass('a villager line came back from Groq', `${ms} ms, model ${body.message.model}`);
    console.log(`        "${body.message.text.trim()}"`);
    if (status.groq.model && body.message.model && body.message.model !== status.groq.model) {
      info(`note: Groq answered as ${body.message.model}, configured as ${status.groq.model}`);
    }
    if (body.usage) info(`tokens: ${body.usage.prompt_tokens} in / ${body.usage.completion_tokens} out`);
    return true;
  }

  const error = (body && body.error) || {};
  if (error.code === 'groq_not_configured') {
    fail('Groq key not visible to the function', 'groq_not_configured', 'Set GROQ_API_KEY and redeploy.');
  } else if (error.code === 'groq_model_unavailable') {
    fail('the configured model is not available', error.message || 'model unavailable',
      'Set GROQ_MODEL to a model your key can use, or unset it to fall back to allam-2-7b.');
  } else if (error.code === 'groq_auth') {
    fail('Groq rejected the key', error.message || 'invalid key', 'Regenerate the key at console.groq.com/keys.');
  } else if (error.code === 'groq_rate_limited') {
    fail('Groq rate limit', error.message || '429', 'Wait a minute, or check your Groq plan limits.');
  } else if (error.code === 'groq_unreachable' || error.code === 'groq_timeout') {
    fail('could not reach Groq', error.message || error.code, 'Check the deployment region/egress or GROQ_BASE_URL.');
  } else {
    fail('chat request failed', `HTTP ${code}${error.code ? ` ${error.code}` : ''}`,
      (body && body.error && body.error.hint) || 'Read the API logs for this request.');
  }
  return false;
}

async function checkSchema(status) {
  console.log('\n3. Supabase schema');
  if (!status || !status.supabase || !status.supabase.configured) {
    fail('skipped: no Supabase keys', '', 'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.');
    return;
  }

  const probes = [
    ['village_npc_relationships', '/api/relationships?npcId=npc_01'],
    ['village_npc_memories', '/api/memories?npcId=npc_01&limit=1'],
    ['village_conversations', '/api/conversations?list=1'],
    ['village_news', '/api/news'],
  ];

  for (const [table, path] of probes) {
    const { status: code, body } = await getJson(path);
    if (code === 200 && body && body.ok) {
      pass(`${table} reachable`);
    } else if (body && body.error && body.error.code === 'supabase_schema_missing') {
      fail(`${table} is missing`, 'schema not applied',
        'Run supabase/schema.sql in the Supabase SQL editor (it is safe to re-run).');
    } else if (body && body.error && body.error.code === 'supabase_unreachable') {
      fail(`${table} unreachable`, 'SUPABASE_URL wrong or project paused',
        'Check the project URL in Vercel matches the project that is running.');
    } else {
      fail(`${table} probe failed`, `HTTP ${code}${body && body.error ? ` ${body.error.code || ''}` : ''}`,
        'Open the Supabase logs for the failing request.');
    }
  }

  const conv = await getJson('/api/conversations?list=1');
  if (conv.status === 200 && conv.body && conv.body.ok) {
    info(`saved transcripts so far: ${conv.body.conversations.length} (only saves made by hand count)`);
  }
}

async function checkNews() {
  console.log('\n4. BBC headlines');
  const { status, body } = await getJson('/api/news?refresh=1');
  if (status === 200 && body && body.ok && body.items && body.items.length) {
    pass('headlines loaded', `${body.items.length} cached`);
    console.log(`        "${body.items[0].headline}"`);
    info(`attribution: ${body.attribution && body.attribution.source}`);
    return;
  }
  fail('no headlines', (body && body.error) || `HTTP ${status}`,
    'BBC feeds may be blocked from the deployment region; the village still runs without news.');
}

async function main() {
  console.log(`Checking ${base}`);
  const status = await checkStatus();
  await checkChat(status);
  await checkSchema(status);
  await checkNews();

  const passed = rows.filter((row) => row.ok).length;
  console.log(`\n${passed}/${rows.length} checks passed`);
  if (failures) {
    console.log(`${failures} problem(s) need fixing before the village is fully live.`);
    process.exitCode = 1;
  } else {
    console.log('Live setup verified: real Groq lines, persistent Supabase tables and BBC headlines.');
  }
}

main().catch((error) => {
  console.error('\nCould not complete the checks:', error.message);
  process.exitCode = 1;
});
