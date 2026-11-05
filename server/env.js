// Configuration, read once per request from the environment.
//
// Nothing here ever leaves the server: the browser only learns whether a piece of
// configuration exists (see api/status.js), never its value.

export const DEFAULT_MODEL = 'allam-2-7b';
export const DEFAULT_GROQ_BASE = 'https://api.groq.com/openai/v1';

// BBC News RSS. The BBC allows individuals to display these feeds as long as the
// feed is not altered and BBC News is credited with a link, which the Conversation
// Logs panel does. No scraping, no article text, headlines and summaries only.
export const DEFAULT_FEEDS = [
  { url: 'https://feeds.bbci.co.uk/news/rss.xml', category: 'top' },
  { url: 'https://feeds.bbci.co.uk/news/technology/rss.xml', category: 'technology' },
  { url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml', category: 'science' },
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', category: 'world' },
];

function feedList() {
  const raw = (process.env.BBC_FEEDS || '').trim();
  if (!raw) return DEFAULT_FEEDS;
  const parsed = [];
  for (const entry of raw.split(',')) {
    const url = entry.trim();
    // https anywhere, plain http only for a local test feed
    const allowed = /^https:\/\//i.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/i.test(url);
    if (!allowed) continue;
    parsed.push({ url, category: 'news' });
  }
  return parsed.length ? parsed : DEFAULT_FEEDS;
}

export function config() {
  return {
    groqKey: (process.env.GROQ_API_KEY || '').trim(),
    // The model is configured in exactly one place. Changing it here (or with the
    // GROQ_MODEL environment variable) changes it for every conversation.
    groqModel: (process.env.GROQ_MODEL || '').trim() || DEFAULT_MODEL,
    groqBase: ((process.env.GROQ_BASE_URL || '').trim() || DEFAULT_GROQ_BASE).replace(/\/+$/, ''),
    supabaseUrl: (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, ''),
    supabaseAnonKey: (process.env.SUPABASE_ANON_KEY || '').trim(),
    supabaseServiceKey: (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
    newsFeeds: feedList(),
    newsTtlMs: Math.max(60_000, Number(process.env.NEWS_TTL_MS) || 15 * 60_000),
  };
}

export function groqConfigured() {
  return !!config().groqKey;
}

export function supabaseConfigured() {
  const c = config();
  return !!(c.supabaseUrl && c.supabaseServiceKey);
}

// A short, safe description of what is missing, for the debug panel and for the
// error body. It names variables, never values.
export function missingConfig() {
  const c = config();
  const missing = [];
  if (!c.groqKey) missing.push('GROQ_API_KEY');
  if (!c.supabaseUrl) missing.push('SUPABASE_URL');
  if (!c.supabaseServiceKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  return missing;
}
