// What the villagers remember.
//
// Not every line becomes a memory: that would flood the prompt and make everyone
// sound like a transcript reader. A conversation is examined for the few things worth
// keeping - meeting someone, finding a shared interest, a relationship reaching a new
// stage, a disagreement, a headline someone cared about - and those are stored with an
// importance score and a stable id, so a retry cannot duplicate them.
//
// Memories persist on their own schedule through api/memories.js. A transcript being
// saved or discarded makes no difference to them.

import { createRetryQueue } from './sync_queue.js';

const STORAGE_KEY = 'aivillage.memories.v1';
const ENDPOINT = '/api/memories';

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function clean(text, max = 160) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function createMemories({
  endpoint = ENDPOINT,
  storage = safeStorage(),
  now = () => Date.now(),
  onStatus = null,
  // memories are held locally until the server says it can store them
  enabled = () => true,
} = {}) {
  const list = [];
  const byId = new Map();
  const dirty = new Set();
  const loaded = new Set();
  const state = { loadedFromServer: 0, loadError: null, saves: 0, saveError: null, persistBlocked: null };

  function persistLocal() {
    if (!storage) return;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify({ v: 2, memories: list.slice(-300) }));
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
      for (const memory of parsed.memories || []) {
        if (!memory || !memory.id || byId.has(memory.id)) continue;
        list.push(memory);
        byId.set(memory.id, memory);
      }
    } catch {
      // discard a corrupt mirror
    }
  }

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
      state.persistBlocked = 'Supabase is not configured on this server.';
      return { ok: true, saved: 0, blocked: true };
    }
    state.persistBlocked = null;
    const batch = [...dirty].slice(0, 30).map((id) => byId.get(id)).filter(Boolean).map((memory) => ({
      id: memory.id,
      npcId: memory.npcId,
      aboutNpcId: memory.aboutNpcId,
      kind: memory.kind,
      description: memory.description,
      importance: memory.importance,
      context: memory.context,
      conversationId: memory.conversationId,
      createdAt: memory.createdAt,
    }));

    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memories: batch }),
      });
    } catch {
      return { ok: false, saved: 0, error: 'network' };
    }
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || !body.ok) {
      return { ok: false, saved: 0, error: (body && body.error && body.error.message) || `save ${res.status}` };
    }
    for (const id of batch.map((memory) => memory.id)) dirty.delete(id);
    return { ok: true, saved: batch.length };
  }

  async function loadFor(npcId) {
    if (!npcId || loaded.has(npcId)) return;
    if (!enabled()) {
      state.loadError = 'Supabase is not configured on this server.';
      return;
    }
    loaded.add(npcId);
    try {
      const res = await fetch(`${endpoint}?npcId=${encodeURIComponent(npcId)}&limit=30`, { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body || !body.ok) {
        state.loadError = (body && body.error && body.error.message) || `load ${res.status}`;
        return;
      }
      for (const memory of body.memories || []) {
        if (!memory || !memory.id || byId.has(memory.id)) continue;
        list.push(memory);
        byId.set(memory.id, memory);
        state.loadedFromServer += 1;
      }
      persistLocal();
    } catch {
      state.loadError = 'network';
    }
  }

  function remember({ npcId, aboutNpcId = null, kind = 'event', description, importance = 0.5, context = '', conversationId = null, dedupeKey = null }) {
    const text = clean(description, 220);
    if (!npcId || !text) return null;
    const id = `m_${hash(`${dedupeKey || `${npcId}|${kind}|${text}`}`)}`;
    if (byId.has(id)) return null;
    const memory = {
      id,
      npcId,
      aboutNpcId: aboutNpcId === npcId ? null : aboutNpcId,
      kind,
      description: text,
      importance: Math.min(1, Math.max(0, Number(importance) || 0.5)),
      context: clean(context, 120),
      conversationId,
      createdAt: new Date(now()).toISOString(),
    };
    list.push(memory);
    byId.set(id, memory);
    dirty.add(id);
    persistLocal();
    queue.schedule();
    return memory;
  }

  // Examine a finished conversation and keep at most four things from it.
  function consider(session, { profileA, profileB, relationshipChanges = [], news = null, disagreement = false } = {}) {
    const created = [];
    const a = session.participants[0];
    const b = session.participants[1];
    const conv = session.id;
    const when = new Date(now()).toISOString();

    const add = (args) => {
      const memory = remember({ ...args, conversationId: conv });
      if (memory) created.push(memory);
    };

    const recordAB = relationshipChanges.find((change) => change.npcId === a.id);
    const firstMeeting = !recordAB || recordAB.interactions === 1;

    if (firstMeeting && created.length < 4) {
      add({
        npcId: a.id,
        aboutNpcId: b.id,
        kind: 'milestone',
        description: `Met ${b.name} for the first time and had a proper talk.`,
        importance: 0.62,
        context: clean(firstLine(session)),
        dedupeKey: `first|${a.id}|${b.id}`,
        when,
      });
      add({
        npcId: b.id,
        aboutNpcId: a.id,
        kind: 'milestone',
        description: `Met ${a.name} for the first time and had a proper talk.`,
        importance: 0.62,
        context: clean(firstLine(session)),
        dedupeKey: `first|${b.id}|${a.id}`,
        when,
      });
    }

    // A shared interest is worth remembering: it is what makes friends out of
    // neighbours, and it is a concrete thing to bring up next time.
    const interestsA = new Set((profileA && profileA.interests ? profileA.interests : []).map((entry) => entry.toLowerCase()));
    const topics = (profileB && profileB.interests ? profileB.interests : []).filter((entry) => interestsA.has(entry.toLowerCase()));
    if (topics.length && created.length < 4) {
      const topic = topics[0];
      add({
        npcId: a.id,
        aboutNpcId: b.id,
        kind: 'shared',
        description: `Found out ${b.name} is also into ${topic}.`,
        importance: 0.58,
        context: clean(session.topicLine || ''),
        dedupeKey: `interest|${a.id}|${b.id}|${topic.toLowerCase()}`,
      });
      add({
        npcId: b.id,
        aboutNpcId: a.id,
        kind: 'shared',
        description: `Found out ${a.name} is also into ${topic}.`,
        importance: 0.58,
        context: clean(session.topicLine || ''),
        dedupeKey: `interest|${b.id}|${a.id}|${topic.toLowerCase()}`,
      });
    }

    // A new stage in the relationship is a milestone, not a conversation note.
    for (const change of relationshipChanges) {
      if (!change.promoted) continue;
      const other = change.npcId === a.id ? b : a;
      add({
        npcId: change.npcId,
        aboutNpcId: other.id,
        kind: 'milestone',
        description: `Became ${change.promoted} with ${other.name} after a good talk.`,
        importance: 0.9,
        context: clean(firstLine(session)),
        dedupeKey: `milestone|${change.npcId}|${other.id}|${change.promoted}`,
      });
    }

    if (disagreement && created.length < 4) {
      add({
        npcId: a.id,
        aboutNpcId: b.id,
        kind: 'disagreement',
        description: `Had a tense exchange with ${b.name}. It did not end well.`,
        importance: 0.78,
        context: clean(lastLine(session)),
        dedupeKey: `disagree|${a.id}|${b.id}|${when.slice(0, 10)}`,
      });
      add({
        npcId: b.id,
        aboutNpcId: a.id,
        kind: 'disagreement',
        description: `Had a tense exchange with ${a.name}. It did not end well.`,
        importance: 0.78,
        context: clean(lastLine(session)),
        dedupeKey: `disagree|${b.id}|${a.id}|${when.slice(0, 10)}`,
      });
    }

    if (news && news.headline && created.length < 4) {
      const interested = [profileA, profileB].find((profile) => profile && profile.social && Number(profile.social.newsInterest) > 0.45);
      const owner = interested === profileA ? a : interested === profileB ? b : null;
      if (owner) {
        const other = owner === a ? b : a;
        add({
          npcId: owner.id,
          aboutNpcId: other.id,
          kind: 'news',
          description: `Talked with ${other.name} about the news: ${clean(news.headline, 90)}.`,
          importance: 0.46,
          context: 'BBC News',
          dedupeKey: `news|${owner.id}|${news.id || news.headline}`,
        });
      }
    }

    return created;
  }

  function recall(npcId, otherId, { limit = 5 } = {}) {
    loadFor(npcId).catch(() => {});
    if (otherId) loadFor(otherId).catch(() => {});
    const nowMs = now();
    const mine = list.filter((memory) => memory.npcId === npcId);
    const scored = mine.map((memory) => {
      const ageDays = Math.max(0, (nowMs - Date.parse(memory.createdAt)) / 86_400_000);
      const recency = 1 / (1 + ageDays / 7);
      const about = memory.aboutNpcId && memory.aboutNpcId === otherId ? 0.25 : 0;
      return { memory, weight: (Number(memory.importance) || 0.4) * 0.7 + recency * 0.3 + about };
    });
    return scored.sort((x, y) => y.weight - x.weight).slice(0, limit).map((entry) => entry.memory);
  }

  loadLocal();

  return {
    remember,
    consider,
    recall,
    loadFor,
    all: () => list.slice(),
    for: (npcId) => list.filter((memory) => memory.npcId === npcId),
    status: () => ({ ...state, local: list.length, pending: dirty.size }),
    saveNow: () => queue.schedule(),
  };
}

function firstLine(session) {
  const message = (session.messages || [])[0];
  return message ? `${message.speakerName}: ${message.text}` : '';
}

function lastLine(session) {
  const message = (session.messages || [])[(session.messages || []).length - 1];
  return message ? `${message.speakerName}: ${message.text}` : '';
}

function safeStorage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}
