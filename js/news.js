// World news, as a conversation topic.
//
// The server fetches the BBC's RSS feeds and keeps only headline, one-line summary
// and link, cached. This module holds that cache in the browser, refreshes it rarely,
// and picks a headline for a villager who cares about the news. A villager who does
// not care about the news simply never gets one.
//
// Nothing here invents a story: if the feed is down the cache is used, and if there
// is no cache there is no news topic.

const STORAGE_KEY = 'aivillage.news.v1';
const DEFAULT_REFRESH = 20 * 60_000;

const CATEGORY_HINTS = {
  technology: ['games', 'his car', 'fashion', 'business', 'networking', 'puzzles'],
  science: ['bugs', 'gardening', 'the weather', 'patterns', 'the unknown', 'moonlight'],
  world: ['the city', 'second chances', 'fairness', 'fate'],
  top: [],
  news: [],
};

export function createNewsFeed({
  url = '/api/news',
  refreshMs = DEFAULT_REFRESH,
  storage = safeStorage(),
  rng = Math.random,
} = {}) {
  const state = {
    items: [],
    fetchedAt: null,
    error: null,
    attribution: null,
    lastRefresh: 0,
    used: [],
  };

  function loadCache() {
    if (!storage) return;
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.items)) state.items = parsed.items.filter((item) => item && item.headline);
      state.fetchedAt = parsed.fetchedAt || null;
      state.attribution = parsed.attribution || null;
    } catch {
      // a broken cache is not worth a console error; the next refresh replaces it
    }
  }

  function saveCache() {
    if (!storage) return;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify({
        items: state.items.slice(0, 24),
        fetchedAt: state.fetchedAt,
        attribution: state.attribution,
      }));
    } catch {
      // storage full or disabled: news still works for this session
    }
  }

  async function refresh({ force = false } = {}) {
    if (!force && Date.now() - state.lastRefresh < 60_000) return state;
    state.lastRefresh = Date.now();
    try {
      const res = await fetch(`${url}${force ? '?refresh=1' : ''}`, { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || !body.ok) {
        state.error = (body && body.error && body.error.message) || `news ${res.status}`;
        return state;
      }
      if (Array.isArray(body.items) && body.items.length) {
        state.items = body.items;
        state.fetchedAt = body.fetchedAt || new Date().toISOString();
        state.attribution = body.attribution || null;
        state.error = body.error || null;
        saveCache();
      } else {
        state.error = body.error || 'No headlines right now.';
      }
    } catch {
      state.error = 'Could not reach the news service.';
    }
    return state;
  }

  function start() {
    loadCache();
    refresh().catch(() => {});
    const timer = setInterval(() => { refresh().catch(() => {}); }, refreshMs);
    return () => clearInterval(timer);
  }

  // A headline for this villager, weighted by whether their interests match the
  // story's category, and never one they have already talked about recently.
  function pick(profile) {
    if (!state.items.length) return null;
    const interest = profile && profile.social ? Number(profile.social.newsInterest) || 0 : 0.25;
    if (rng() > 0.25 + interest) return null;

    const words = new Set([
      ...(profile && profile.interests ? profile.interests : []),
      ...(profile && profile.likes ? profile.likes : []),
    ].map((entry) => String(entry).toLowerCase()));

    const scored = state.items
      .filter((item) => !state.used.includes(item.id))
      .map((item) => {
        const hints = CATEGORY_HINTS[item.category] || [];
        const match = hints.some((hint) => [...words].some((word) => word.includes(hint) || hint.includes(word)));
        const fresh = item.publishedAt ? Math.max(0, 1 - (Date.now() - Date.parse(item.publishedAt)) / 172_800_000) : 0.3;
        return { item, score: (match ? 1.5 : 0) + fresh + rng() * 0.4 };
      })
      .sort((a, b) => b.score - a.score);

    if (!scored.length) {
      state.used = [];
      return pick(profile);
    }
    const chosen = scored[0].item;
    state.used.push(chosen.id);
    if (state.used.length > 12) state.used.shift();
    return chosen;
  }

  return {
    start,
    refresh,
    pick,
    items: () => state.items.slice(),
    attribution: () => state.attribution,
    status: () => ({
      items: state.items.length,
      fetchedAt: state.fetchedAt,
      error: state.error,
      source: 'BBC News',
    }),
  };
}

function safeStorage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}
