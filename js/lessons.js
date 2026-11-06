// What a villager has learned from being corrected or praised.
//
// A left click during a conversation is a punishment: the subject being discussed
// becomes a subject that villager avoids. A right click is a reward: the subject is
// remembered as a good habit worth returning to. Lessons live in localStorage, next
// to the studio profiles, so they survive a refresh even when Supabase is unavailable.
//
// This module is deliberately data-only. The conversation manager decides which
// subject is being taught, and the prompt builder decides how to word the lesson.

export const STORAGE_KEY = 'aivillage.lessons.v1';
const MAX_PER_KIND = 12;

function cleanTopic(topic) {
  return String(topic || '').replace(/\s+/g, ' ').trim().slice(0, 70);
}

function keyOf(topic) {
  return cleanTopic(topic).toLowerCase();
}

function safeStorage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function normaliseEntry(raw) {
  const topic = cleanTopic(raw && raw.topic);
  if (!topic) return null;
  return {
    topic,
    count: Math.max(1, Number(raw && raw.count) || 1),
    at: String((raw && raw.at) || ''),
  };
}

export function createLessons({
  storage = safeStorage(),
  now = () => Date.now(),
} = {}) {
  // npcId -> { avoid: [{ topic, count, at }], good: [...] }
  const book = new Map();

  function load() {
    if (!storage) return;
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      for (const [npcId, value] of Object.entries((parsed && parsed.lessons) || {})) {
        if (!npcId || !value || typeof value !== 'object') continue;
        const avoid = (Array.isArray(value.avoid) ? value.avoid : []).map(normaliseEntry).filter(Boolean).slice(0, MAX_PER_KIND);
        const good = (Array.isArray(value.good) ? value.good : []).map(normaliseEntry).filter(Boolean).slice(0, MAX_PER_KIND);
        if (avoid.length || good.length) book.set(npcId, { avoid, good });
      }
    } catch {
      // a corrupt mirror is discarded; the villager simply starts with no lessons
    }
  }

  function persist() {
    if (!storage) return;
    try {
      const lessons = {};
      for (const [npcId, value] of book) lessons[npcId] = value;
      storage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, lessons }));
    } catch {
      // storage disabled: lessons still work for this session
    }
  }

  function recordFor(npcId) {
    if (!npcId) return null;
    if (!book.has(npcId)) book.set(npcId, { avoid: [], good: [] });
    return book.get(npcId);
  }

  function listFor(npcId, kind) {
    const record = book.get(npcId);
    const list = record && Array.isArray(record[kind]) ? record[kind] : [];
    return list.map((entry) => entry.topic);
  }

  // One lesson replaces the opposite lesson for the same subject: being praised for
  // something previously punished means the villager has learned a new response.
  function record(npcId, kind, topic) {
    const label = cleanTopic(topic);
    if (!npcId || !label) return null;
    const action = kind === 'good' ? 'good' : 'avoid';
    const other = action === 'good' ? 'avoid' : 'good';
    const record = recordFor(npcId);
    const key = keyOf(label);

    record[other] = record[other].filter((entry) => keyOf(entry.topic) !== key);
    const existing = record[action].find((entry) => keyOf(entry.topic) === key);
    const at = new Date(now()).toISOString();
    let learned;
    if (existing) {
      existing.topic = label;
      existing.count += 1;
      existing.at = at;
      learned = existing;
    } else {
      learned = { topic: label, count: 1, at };
      record[action].unshift(learned);
      record[action] = record[action].slice(0, MAX_PER_KIND);
    }
    persist();
    return { npcId, kind: action, topic: learned.topic, count: learned.count, at: learned.at };
  }

  function avoids(npcId) {
    return new Set(listFor(npcId, 'avoid').map(keyOf));
  }

  function isAvoided(npcId, topic) {
    return avoids(npcId).has(keyOf(topic));
  }

  function isGood(npcId, topic) {
    return new Set(listFor(npcId, 'good').map(keyOf)).has(keyOf(topic));
  }

  load();

  return {
    record,
    avoidTopics: (npcId) => listFor(npcId, 'avoid'),
    goodHabits: (npcId) => listFor(npcId, 'good'),
    isAvoided,
    isGood,
    forNpc: (npcId) => {
      const record = book.get(npcId);
      return {
        avoid: record ? record.avoid.map((entry) => ({ ...entry })) : [],
        good: record ? record.good.map((entry) => ({ ...entry })) : [],
      };
    },
    status: () => ({
      villagers: book.size,
      avoided: [...book.values()].reduce((sum, value) => sum + value.avoid.length, 0),
      praised: [...book.values()].reduce((sum, value) => sum + value.good.length, 0),
    }),
  };
}
