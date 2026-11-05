// Supabase, server-side, over the REST API.
//
// Only the service-role key is used here, so every call is privileged. That is why
// this module is never imported by browser code: the client talks to the API routes
// instead. Row Level Security is on for all village tables and grants nothing to the
// anon key, so the only way in is through these routes.

import { config, supabaseConfigured } from './env.js';
import { HttpError } from './http.js';

export const TABLES = {
  relationships: 'village_npc_relationships',
  memories: 'village_npc_memories',
  conversations: 'village_conversations',
  messages: 'village_conversation_messages',
  news: 'village_news',
};

export function isConfigured() {
  return supabaseConfigured();
}

function headers(extra = {}) {
  const cfg = config();
  return {
    apikey: cfg.supabaseServiceKey,
    Authorization: `Bearer ${cfg.supabaseServiceKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...extra,
  };
}

function baseUrl() {
  const cfg = config();
  if (!cfg.supabaseUrl || !cfg.supabaseServiceKey) {
    throw new HttpError(503, 'supabase_not_configured', 'Supabase is not configured on the server.', {
      missing: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].filter((name) => (
        name === 'SUPABASE_URL' ? !cfg.supabaseUrl : !cfg.supabaseServiceKey
      )),
    });
  }
  return `${cfg.supabaseUrl}/rest/v1`;
}

function queryString(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

async function request(method, path, { body, prefer, query, timeoutMs = 8000 } = {}) {
  const url = `${baseUrl()}/${path}${queryString(query)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: headers(prefer ? { Prefer: prefer } : {}),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    const timedOut = controller.signal.aborted;
    throw new HttpError(
      timedOut ? 504 : 502,
      timedOut ? 'supabase_timeout' : 'supabase_unreachable',
      timedOut ? 'Supabase did not answer in time.' : 'Could not reach Supabase.',
    );
  }
  clearTimeout(timer);

  const text = await res.text().catch(() => '');
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!res.ok) {
    const message = payload && (payload.message || payload.error_description || payload.hint);
    const code = payload && payload.code;
    // 42P01 / PGRST205 / "Could not find the table ... in the schema cache" all mean
    // the schema has not been applied to this project yet (or PostgREST has not
    // reloaded after it was applied). A setup problem worth naming precisely.
    if (code === '42P01' || code === 'PGRST205' || (message && /does not exist|could not find the table/i.test(message))) {
      throw new HttpError(503, 'supabase_schema_missing', 'A village table is missing. Run supabase/schema.sql in the Supabase SQL editor.', {
        detail: String(message || '').slice(0, 160),
      });
    }
    throw new HttpError(502, 'supabase_error', 'Supabase rejected the request.', {
      status: res.status,
      detail: String(message || `HTTP ${res.status}`).slice(0, 200),
    });
  }

  return payload;
}

export function select(table, { columns = '*', eq = {}, limit = 100, order = null } = {}) {
  const query = { select: columns, limit };
  for (const [key, value] of Object.entries(eq)) {
    if (value !== undefined && value !== null) query[key] = `eq.${value}`;
  }
  if (order) query.order = order;
  return request('GET', table, { query });
}

// Upsert with a conflict target so a repeated background save can never duplicate a
// row: the retry after a flaky network sees the same primary key.
export function upsert(table, rows, { onConflict, ignoreDuplicates = false } = {}) {
  const list = Array.isArray(rows) ? rows : [rows];
  if (!list.length) return Promise.resolve([]);
  return request('POST', table, {
    body: list,
    query: onConflict ? { on_conflict: onConflict } : {},
    prefer: `resolution=${ignoreDuplicates ? 'ignore' : 'merge'}-duplicates,return=representation`,
  });
}

export function insert(table, rows) {
  return upsert(table, rows, {});
}

export function update(table, patch, eq) {
  const query = {};
  for (const [key, value] of Object.entries(eq)) query[key] = `eq.${value}`;
  return request('PATCH', table, { body: patch, query, prefer: 'return=representation' });
}
