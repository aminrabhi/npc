// BBC News through the corporation's own RSS feeds.
//
// The BBC publishes these feeds for exactly this use: an individual may display
// them unchanged, credited as BBC News with a link back. So this module fetches the
// XML, keeps the headline, the one-line description and the link, and never touches
// an article body. No scraping, no paywall bypass.
//
// The result is cached in memory (per serverless instance) and, when Supabase is
// configured, in village_news so a cold instance still has something to show. A
// failed refresh falls back to the last good cache instead of breaking the village.

import { config } from './env.js';
import { isConfigured, select, upsert, TABLES } from './supabase.js';

const CACHE_MS = () => config().newsTtlMs;
let cache = { at: 0, items: [], error: null, source: 'bbc' };
let inflight = null;

function decodeEntities(text) {
  return String(text || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function stripTags(text) {
  // Real BBC items wrap <title> and <description> in CDATA. The wrapper has to be
  // unwrapped before tags are stripped: `<[^>]*>` would otherwise swallow the whole
  // block, because `<![CDATA[headline]]>` contains no `>` until its closing `]]>`.
  const unwrapped = String(text || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  return decodeEntities(unwrapped.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function pickTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return match ? stripTags(match[1]) : '';
}

export function parseRss(xml, category = 'news') {
  const items = [];
  const blocks = String(xml || '').match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const block of blocks) {
    const headline = pickTag(block, 'title');
    if (!headline) continue;
    const url = pickTag(block, 'link');
    const summary = pickTag(block, 'description').slice(0, 240);
    const published = pickTag(block, 'pubDate');
    const date = published ? new Date(published) : null;
    items.push({
      id: hashId(`${headline}|${url}`),
      headline,
      summary,
      url,
      category,
      source: 'BBC News',
      publishedAt: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
    });
  }
  return items;
}

function hashId(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `n_${(h >>> 0).toString(36)}`;
}

async function fetchFeed(feed, timeoutMs = 6500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(feed.url, {
      headers: {
        'User-Agent': 'Simulora/2.0 (+village simulation; RSS headlines only)',
        Accept: 'application/rss+xml, application/xml, text/xml',
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${feed.url} answered ${res.status}`);
    const xml = await res.text();
    return parseRss(xml, feed.category).slice(0, 8);
  } finally {
    clearTimeout(timer);
  }
}

async function refresh() {
  const feeds = config().newsFeeds;
  const results = await Promise.allSettled(feeds.map((feed) => fetchFeed(feed)));
  const items = [];
  const seen = new Set();
  const errors = [];
  for (const result of results) {
    if (result.status === 'rejected') {
      errors.push(String(result.reason && result.reason.message ? result.reason.message : result.reason).slice(0, 120));
      continue;
    }
    for (const item of result.value) {
      if (!item.headline || seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }
  if (!items.length) throw new Error(errors[0] || 'No headlines in the feed.');
  // keep the whole set interesting but bounded: newest first, then a couple of each
  // category so a curious villager can find a technology story
  items.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
  return items.slice(0, 24);
}

async function readStored() {
  if (!isConfigured()) return [];
  try {
    const rows = await select(TABLES.news, { limit: 24, order: 'fetched_at.desc' });
    return (rows || [])
      .filter((row) => row && row.headline)
      .map((row) => ({
        id: row.id,
        headline: row.headline,
        summary: row.summary || '',
        url: row.url || '',
        category: row.category || 'news',
        source: 'BBC News',
        publishedAt: row.published_at,
      }));
  } catch {
    return [];
  }
}

async function store(items) {
  if (!isConfigured()) return;
  try {
    await upsert(
      TABLES.news,
      items.map((item) => ({
        id: item.id,
        headline: item.headline,
        summary: item.summary || null,
        url: item.url || null,
        category: item.category || 'news',
        source: item.source,
        published_at: item.publishedAt,
        fetched_at: new Date().toISOString(),
      })),
      { onConflict: 'id' },
    );
  } catch {
    // the cache is a convenience; news must never be the reason a save fails
  }
}

export async function getNews({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.items.length && now - cache.at < CACHE_MS()) {
    return { items: cache.items, fresh: false, cached: true, fetchedAt: new Date(cache.at).toISOString(), error: cache.error };
  }

  if (!inflight) {
    inflight = (async () => {
      try {
        const items = await refresh();
        cache = { at: Date.now(), items, error: null };
        store(items);
        return { items, fresh: true, cached: false, fetchedAt: new Date(cache.at).toISOString(), error: null };
      } catch (error) {
        const message = String(error && error.message ? error.message : error).slice(0, 160);
        if (!cache.items.length) {
          const stored = await readStored();
          if (stored.length) {
            cache = { at: Date.now(), items: stored, error: message };
          }
        }
        cache = { ...cache, error: message, at: cache.items.length ? cache.at : Date.now() };
        return {
          items: cache.items,
          fresh: false,
          cached: true,
          fetchedAt: cache.at ? new Date(cache.at).toISOString() : null,
          error: message,
        };
      } finally {
        inflight = null;
      }
    })();
  }
  return inflight;
}

export function newsStatus() {
  return {
    feeds: config().newsFeeds.map((feed) => feed.category),
    cachedItems: cache.items.length,
    cachedAt: cache.at ? new Date(cache.at).toISOString() : null,
    error: cache.error,
  };
}
