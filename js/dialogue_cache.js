// Cache of lines the model has actually produced.
//
// When Groq works, its best lines are worth keeping: a village that has already heard
// a good line about rain does not need to spend tokens to hear it again. When Groq
// stops working, the cache is the second rung of the ladder - more varied than the
// procedural engine, still never a network call.
//
// A cached line is only offered for a comparable moment: same kind of turn (opening,
// reply, closing), same mood, and the same weather, time of day or subject where that
// is known. Lines are never served twice in quick succession.

const STORAGE_KEY = 'simulora.dialogue_cache.v1';
const DEFAULT_LIMIT = 200;
const REUSE_AFTER_MS = 20 * 60_000;

function clean(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function words(text) {
  return clean(text).toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
}

function similar(a, b) {
  const left = new Set(words(a).filter((word) => word.length >= 3));
  const right = new Set(words(b).filter((word) => word.length >= 3));
  if (left.size < 3 || right.size < 3) return false;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.min(left.size, right.size) >= 0.7;
}

export function createDialogueCache({
  storage = safeStorage(),
  limit = DEFAULT_LIMIT,
  now = () => Date.now(),
} = {}) {
  let entries = [];

  try {
    const raw = storage && storage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.entries)) {
        entries = parsed.entries.filter((entry) => entry && typeof entry.text === 'string' && entry.text);
      }
    }
  } catch {
    entries = [];
  }

  function persist() {
    if (!storage) return;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, entries: entries.slice(-limit) }));
    } catch {
      // storage full or disabled: the in-memory copy still serves this session
    }
  }

  function remember({ text, mode = 'reply', mood = 'calm', topic = '', weatherKey = '', timeOfDay = '', category = '' } = {}) {
    const value = clean(text);
    if (!value || value.length > 110) return null;
    if (!/^[A-Za-z0-9'"]/.test(value)) return null;
    // Do not stock several near-copies of one line.
    if (entries.some((entry) => similar(entry.text, value))) return null;
    const entry = {
      text: value,
      mode,
      mood: mood === 'tense' ? 'tense' : 'calm',
      topic: String(topic || '').slice(0, 70),
      weatherKey: String(weatherKey || ''),
      timeOfDay: String(timeOfDay || ''),
      category: String(category || ''),
      at: now(),
      usedAt: 0,
    };
    entries.push(entry);
    if (entries.length > limit) entries = entries.slice(-limit);
    persist();
    return entry;
  }

  // Pick the cached line that fits this moment best. `avoid` holds the lines already
  // said in this conversation, so the cache cannot make a chat repeat itself.
  function take({ mode = 'reply', mood = 'calm', topic = '', weatherKey = '', timeOfDay = '', category = '', avoid = [] } = {}) {
    const wantedMood = mood === 'tense' ? 'tense' : 'calm';
    const blocked = new Set((avoid || []).map(clean));
    const scored = [];
    for (const entry of entries) {
      if (entry.mode !== mode) continue;
      if (entry.mood !== wantedMood) continue;
      if (blocked.has(entry.text)) continue;
      if (avoid && avoid.some((line) => similar(line, entry.text))) continue;
      if (entry.usedAt && now() - entry.usedAt < REUSE_AFTER_MS) continue;

      let score = 1;
      if (topic && entry.topic && entry.topic === topic) score += 2.5;
      if (weatherKey && entry.weatherKey && entry.weatherKey === weatherKey) score += 1.5;
      if (timeOfDay && entry.timeOfDay && entry.timeOfDay === timeOfDay) score += 1;
      if (category && entry.category && entry.category === category) score += 1;
      // fresher lines win ties, so the cache ages out rather than looping its oldest hit
      score += Math.max(0, 1 - (now() - entry.at) / (7 * 24 * 60 * 60_000)) * 0.5;
      scored.push({ entry, score });
    }
    if (!scored.length) return null;
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0].entry;
    best.usedAt = now();
    persist();
    return best.text;
  }

  return {
    remember,
    take,
    size: () => entries.length,
    entries: () => entries.slice(),
    clear: () => {
      entries = [];
      persist();
    },
    status: () => ({
      size: entries.length,
      modes: entries.reduce((counts, entry) => {
        counts[entry.mode] = (counts[entry.mode] || 0) + 1;
        return counts;
      }, {}),
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
