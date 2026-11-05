// Relationships, directional and gradual.
//
// Every villager holds their own opinion of every other villager, so A can think the
// world of B while B finds A exhausting. A conversation nudges both records, by
// different amounts, because the same chat does not land the same way on two people.
//
// Two stores exist on purpose:
//   * this one in the browser, which the simulation reads every frame
//   * Supabase, written in the background by api/relationships.js
// The local store is mirrored to localStorage so a refresh keeps the social history
// even if the network is down; the server copy is the one that survives a new device.
//
// Nothing here needs a transcript to be saved. Saving a transcript is a separate,
// manual act in the Conversation Logs panel.

import { createRetryQueue } from './sync_queue.js';

export const CATEGORIES = [
  'stranger', 'neutral', 'acquaintance', 'friendly', 'friend',
  'close friend', 'best friend', 'disliked', 'enemy',
];

const STORAGE_KEY = 'aivillage.relationships.v1';
const ENDPOINT = '/api/relationships';

// The same derivation as server/relationships.js: one formula, two copies.
export function deriveCategory({ score, trust, familiarity, dislike }) {
  const warmth = Number(score) || 0;
  const t = clamp(trust, 0);
  const f = clamp(familiarity, 0);
  const d = clamp(dislike, 0);
  if (warmth <= -50 || (d >= 0.55 && warmth < -20)) return 'enemy';
  if (warmth <= -12 || d >= 0.4) return 'disliked';
  if (f < 0.1 && t < 0.35) return 'stranger';
  if (warmth < 8) return 'neutral';
  if (warmth < 28) return 'acquaintance';
  if (warmth < 48) return 'friendly';
  if (warmth < 68) return 'friend';
  if (warmth < 86 || t < 0.62 || f < 0.45) return 'close friend';
  return 'best friend';
}

const RANK = {
  enemy: -2, disliked: -1, stranger: 0, neutral: 1, acquaintance: 2,
  friendly: 3, friend: 4, 'close friend': 5, 'best friend': 6,
};

function clamp(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

function clampScore(value) {
  return Math.min(100, Math.max(-100, Math.round(value)));
}

const POSITIVE_WORDS = [
  'thank', 'glad', 'good', 'nice', 'love', 'great', 'happy', 'kind', 'fun',
  'lovely', 'appreciate', 'proud', 'welcome', 'beautiful', 'enjoy', 'sorry',
  'please', 'friend', 'help', 'best', 'sweet', 'wonderful', 'yes',
];
const NEGATIVE_WORDS = [
  'hate', 'stupid', 'annoy', 'angry', 'shut', 'liar', 'boring', 'ugly',
  'useless', 'idiot', 'pathetic', 'never speak', 'leave me', 'shut up', 'dumb',
  'worst', 'ridiculous', 'gross',
];

function toneOf(messages) {
  if (!messages.length) return 0;
  let sum = 0;
  for (const message of messages) {
    const text = String(message.text || '').toLowerCase();
    let tone = 0;
    for (const word of POSITIVE_WORDS) if (text.includes(word)) tone += 1;
    for (const word of NEGATIVE_WORDS) if (text.includes(word)) tone -= 1.5;
    // a one-word answer is a weak signal; a full sentence counts for more
    const weight = Math.min(1.6, 0.5 + text.length / 60);
    sum += Math.max(-2, Math.min(2, tone)) * weight;
  }
  return Math.max(-1, Math.min(1, sum / messages.length / 1.2));
}

function sharedInterests(profileA, profileB) {
  const a = new Set((profileA.interests || []).map((entry) => entry.toLowerCase()));
  const b = new Set((profileB.interests || []).map((entry) => entry.toLowerCase()));
  const shared = [];
  for (const value of a) if (b.has(value)) shared.push(value);
  return shared;
}

function clash(profileA, profileB) {
  let count = 0;
  const dislikesA = (profileA.dislikes || []).map((entry) => entry.toLowerCase());
  const likesB = (profileB.likes || []).map((entry) => entry.toLowerCase());
  for (const dislike of dislikesA) {
    if (likesB.some((like) => like.includes(dislike) || dislike.includes(like))) count += 1;
  }
  return count;
}

export function createRelationships({
  endpoint = ENDPOINT,
  storage = safeStorage(),
  onStatus = null,
  // Whether the server has told us it can persist. When Supabase is not configured
  // the browser keeps everything locally and makes no failing requests at all.
  enabled = () => true,
} = {}) {
  const records = new Map();
  const dirty = new Set();
  const state = {
    loadedFromServer: false,
    loadError: null,
    saves: 0,
    saveError: null,
    persistBlocked: null,
  };

  const keyOf = (a, b) => `${a}|${b}`;

  function blank(npcId, otherId) {
    return {
      npcId,
      otherId,
      score: 0,
      trust: 0.3,
      familiarity: 0.08,
      friendliness: 0.4,
      affection: 0.1,
      dislike: 0,
      category: 'stranger',
      interactions: 0,
      lastInteraction: null,
      notes: '',
      updatedAt: null,
    };
  }

  function recordFor(npcId, otherId) {
    const key = keyOf(npcId, otherId);
    let record = records.get(key);
    if (!record) {
      record = blank(npcId, otherId);
      records.set(key, record);
    }
    return record;
  }

  function touch(record) {
    record.updatedAt = new Date().toISOString();
    record.category = deriveCategory(record);
    dirty.add(keyOf(record.npcId, record.otherId));
    persistLocal();
    queue.schedule();
  }

  // ------------------------------------------------------------------ local copy
  function persistLocal() {
    if (!storage) return;
    try {
      const rows = {};
      for (const [key, record] of records) {
        rows[key] = {
          npcId: record.npcId, otherId: record.otherId, score: record.score,
          trust: record.trust, familiarity: record.familiarity,
          friendliness: record.friendliness, affection: record.affection,
          dislike: record.dislike, category: record.category,
          interactions: record.interactions, lastInteraction: record.lastInteraction,
          notes: record.notes, updatedAt: record.updatedAt,
        };
      }
      storage.setItem(STORAGE_KEY, JSON.stringify({ v: 2, rows }));
    } catch {
      // storage disabled: the server copy still holds
    }
  }

  function loadLocal() {
    if (!storage) return;
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      for (const [key, row] of Object.entries(parsed.rows || {})) {
        records.set(key, { ...blank(row.npcId, row.otherId), ...row });
      }
    } catch {
      // a corrupt mirror is discarded, not fatal
    }
  }

  // ------------------------------------------------------------- server copy
  const queue = createRetryQueue({
    run: flush,
    onStatus: (status) => {
      state.saves = status.saved;
      state.saveError = status.lastError;
      if (onStatus) onStatus({ ...state, queue: status });
    },
  });

  async function flush() {
    if (!dirty.size) return { ok: true, saved: 0 };
    if (!enabled()) {
      // keep the rows dirty: if the deployment gains a Supabase project later,
      // saveNow() sends everything that accumulated in the meantime
      state.persistBlocked = 'Supabase is not configured on this server.';
      return { ok: true, saved: 0, blocked: true };
    }
    state.persistBlocked = null;
    const updates = [...dirty].slice(0, 40).map((key) => {
      const record = records.get(key);
      return {
        npcId: record.npcId,
        otherId: record.otherId,
        score: record.score,
        trust: record.trust,
        familiarity: record.familiarity,
        friendliness: record.friendliness,
        affection: record.affection,
        dislike: record.dislike,
        category: record.category,
        interactions: record.interactions,
        lastInteraction: record.lastInteraction,
        notes: record.notes,
      };
    });

    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates }),
      });
    } catch {
      return { ok: false, saved: 0, error: 'network' };
    }
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || !body.ok) {
      return {
        ok: false,
        saved: 0,
        error: (body && body.error && body.error.message) || `save ${res.status}`,
      };
    }
    for (const key of dirty) {
      const record = records.get(key);
      // a record changed while the request was in flight stays dirty
      if (record && record.updatedAt === updates.find((u) => u.npcId === record.npcId && u.otherId === record.otherId)?.lastInteraction) {
        dirty.delete(key);
      }
    }
    dirty.clear();
    return { ok: true, saved: updates.length };
  }

  async function load() {
    if (!enabled()) {
      state.loadError = 'Supabase is not configured on this server.';
      return false;
    }
    try {
      const res = await fetch(`${endpoint}?t=${Date.now()}`, { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || !body.ok) {
        state.loadError = (body && body.error && body.error.message) || `load ${res.status}`;
        return false;
      }
      for (const row of body.relationships || []) {
        const key = keyOf(row.npcId, row.otherId);
        const local = records.get(key);
        const serverTime = row.updatedAt ? Date.parse(row.updatedAt) : 0;
        const localTime = local && local.updatedAt ? Date.parse(local.updatedAt) : 0;
        // local edits made since the last successful save win over the server copy
        if (local && dirty.has(key)) continue;
        if (local && localTime > serverTime) continue;
        records.set(key, {
          npcId: row.npcId,
          otherId: row.otherId,
          score: Number(row.score) || 0,
          trust: clamp(row.trust, 0.3),
          familiarity: clamp(row.familiarity, 0.08),
          friendliness: clamp(row.friendliness, 0.4),
          affection: clamp(row.affection, 0.1),
          dislike: clamp(row.dislike, 0),
          category: row.category || 'stranger',
          interactions: Number(row.interactions) || 0,
          lastInteraction: row.lastInteraction || null,
          notes: row.notes || '',
          updatedAt: row.updatedAt || null,
        });
      }
      state.loadedFromServer = true;
      persistLocal();
      return true;
    } catch {
      state.loadError = 'network';
      return false;
    }
  }

  // ------------------------------------------------------------ conversation
  // One conversation moves both records. The numbers are small on purpose: it takes
  // many good talks, not one, to become someone's best friend.
  function applyConversation(session, { profileA, profileB, disagreement = false, newsUsed = false } = {}) {
    const a = session.participants[0];
    const b = session.participants[1];
    const tone = toneOf(session.messages || []);
    const shared = sharedInterests(profileA || {}, profileB || {});
    const friction = clash(profileA || {}, profileB || {});
    const length = (session.messages || []).length;

    const base = 1.6
      + tone * 2.2
      + Math.min(1.2, shared.length * 0.6)
      + (newsUsed ? 0.4 : 0)
      + Math.min(0.8, length * 0.08)
      - friction * 0.7
      - (disagreement ? 3.2 : 0);

    const changes = [];

    const move = (fromId, toId, toProfile, fromProfile) => {
      const record = recordFor(fromId, toId);
      const before = record.category;
      const sociability = Number(toProfile && toProfile.social ? toProfile.social.sociability : 0.5) || 0.5;
      // outgoing villagers warm up faster; guarded ones take their time
      const scale = 0.55 + sociability * 0.9;
      const comfort = 0.75 + clamp(record.trust, 0) * 0.5;
      const delta = Math.max(-6, Math.min(6, base * scale * comfort));

      record.interactions += 1;
      record.score = clampScore(record.score + delta);
      record.familiarity = clamp(record.familiarity + 0.045 + Math.max(0, tone) * 0.03, 0);
      record.trust = clamp(record.trust + (tone > 0.15 ? 0.035 : tone < -0.15 ? -0.05 : 0.012), 0);
      record.friendliness = clamp(record.friendliness + Math.max(0, tone) * 0.05, 0);
      record.affection = clamp(record.affection + Math.max(0, tone) * 0.04, 0);
      record.dislike = clamp(record.dislike + (tone < -0.2 ? 0.06 : disagreement ? 0.09 : -0.012), 0);
      record.lastInteraction = new Date().toISOString();
      touch(record);

      const after = record.category;
      const change = {
        npcId: fromId,
        otherId: toId,
        otherName: toProfile && toProfile.name,
        from: before,
        to: after,
        delta: Number(delta.toFixed(2)),
        promoted: (RANK[after] || 0) > (RANK[before] || 0) ? after : null,
      };
      changes.push(change);
      return change;
    };

    const changeA = move(a.id, b.id, profileB, profileA);
    const changeB = move(b.id, a.id, profileA, profileB);

    return {
      tone,
      shared,
      friction,
      changes: [changeA, changeB],
      promoted: [changeA.promoted, changeB.promoted].filter(Boolean),
      bestFriends: [changeA, changeB].filter((change) => change.to === 'best friend'),
    };
  }

  // How much this villager wants to talk to that one right now. Used by the lifestyle
  // machine: friends are worth walking to, an enemy is not.
  function appeal(a, b) {
    if (!a || !b || !a.config || !b.config) return 1;
    const record = recordFor(a.config.id, b.config.id);
    if (record.category === 'enemy') return 0.05;
    if (record.category === 'disliked') return 0.3;
    if (record.category === 'stranger') return 0.8;
    // familiar faces are preferred, best friends most of all
    return 0.9 + clamp(record.score / 100, 0) * 0.8 + clamp(record.familiarity, 0) * 0.3;
  }

  function seededRelationships() {
    // the two existing friendships the village starts with, so day one is not ten
    // strangers: a couple of neighbours already know each other
    const seeds = [
      ['npc_04', 'npc_08', 22, 0.35],
      ['npc_08', 'npc_04', 26, 0.35],
      ['npc_09', 'npc_03', 14, 0.22],
      ['npc_03', 'npc_09', 11, 0.2],
      ['npc_07', 'npc_05', 9, 0.18],
      ['npc_05', 'npc_07', 7, 0.15],
    ];
    for (const [npcId, otherId, score, familiarity] of seeds) {
      const record = recordFor(npcId, otherId);
      if (record.interactions > 0) continue;
      record.score = score;
      record.familiarity = familiarity;
      record.trust = 0.4;
      record.interactions = 2;
      record.category = deriveCategory(record);
      dirty.add(keyOf(npcId, otherId));
    }
  }

  loadLocal();
  if (!records.size) seededRelationships();

  return {
    load,
    applyConversation,
    appeal,
    // "for" is a reserved word, so the lookup is called record()
    record: recordFor,
    keyOf,
    category: (a, b) => recordFor(a, b).category,
    snapshot: () => [...records.values()].map((record) => ({ ...record })),
    status: () => ({
      ...state,
      local: records.size,
      pending: dirty.size,
    }),
    saveNow: () => queue.schedule(),
    // Awaitable, so the console can ask "did the last save work?" and get the real
    // answer instead of guessing: __rel.flushNow().then(console.log)
    flushNow: () => flush(),
  };
}

function safeStorage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}
