// What the villagers remember.
//
// Not every line becomes a memory: that would flood the prompt and make everyone
// sound like a transcript reader. A conversation is examined for the few things worth
// keeping - meeting someone, a shared interest, a relationship reaching a new stage,
// a disagreement, a rumour, a confidence - and those are stored with an importance
// score and a stable id, so a retry cannot duplicate them.
//
// A social memory is more than a sentence. It keeps the claim, who made it, whether it
// was first-hand, and how confident the listener is. That is what lets someone repeat
// a rumour later, or decide it was nonsense.
//
// Memories persist on their own schedule through api/memories.js. A transcript being
// saved or discarded makes no difference to them.

import { createRetryQueue } from './sync_queue.js';

// The previous store described the old cast. A new key starts the social history
// cleanly, matching the new relationship graph.
const STORAGE_KEY = 'aivillage.memories.v2';
const ENDPOINT = '/api/memories';

export const SOCIAL_MEMORY_KINDS = new Set([
  'fact', 'opinion', 'rumor', 'grudge', 'secret',  'witnessed',
  'gossip',
  'claim',
  'promise',
]);

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

function socialKind(seed) {
  if (seed.kind === 'secret') return 'secret';
  if (seed.kind === 'grudge' || seed.angle === 'grudge') return 'grudge';
  if (seed.kind === 'rumor' || seed.angle === 'rumor' || seed.angle === 'rumour') return 'rumor';
  if (seed.kind === 'fact' || seed.kind === 'witnessed') return 'fact';
  return 'opinion';
}

function socialDescription(seed, speakerName, subjectName) {
  const claim = clean(seed.claim, 180);
  if (seed.angle === 'secret') return `${speakerName} told me a secret: ${claim}`;
  if (seed.sourceName) return `${speakerName} told me what ${seed.sourceName} said about ${subjectName}: ${claim}`;
  if (seed.angle === 'rumor' || seed.angle === 'rumour') return `${speakerName} told me a rumour about ${subjectName}: ${claim}`;
  if (seed.angle === 'grudge') return `${speakerName} is still angry with ${subjectName}: ${claim}`;
  if (seed.angle === 'defend') return `${speakerName} defended ${subjectName}: ${claim}`;
  if (seed.angle === 'envy') return `${speakerName} seems envious of ${subjectName}: ${claim}`;
  return `${speakerName} told me what they think of ${subjectName}: ${claim}`;
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
      storage.setItem(STORAGE_KEY, JSON.stringify({ v: 3, memories: list.slice(-500) }));
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
      sourceNpcId: memory.sourceNpcId,
      kind: memory.kind,
      description: memory.description,
      claim: memory.claim,
      confidence: memory.confidence,
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
      const res = await fetch(`${endpoint}?npcId=${encodeURIComponent(npcId)}&limit=40`, { cache: 'no-store' });
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

  function remember({
    npcId,
    aboutNpcId = null,
    sourceNpcId = null,
    kind = 'event',
    description,
    claim = '',
    confidence = 0.5,
    importance = 0.5,
    context = '',
    conversationId = null,
    dedupeKey = null,
  }) {
    const text = clean(description, 220);
    if (!npcId || !text) return null;
    const id = `m_${hash(`${dedupeKey || `${npcId}|${kind}|${text}`}`)}`;
    if (byId.has(id)) return null;
    const memory = {
      id,
      npcId,
      aboutNpcId: aboutNpcId === npcId ? null : aboutNpcId,
      // A person cannot be their own source: if they witnessed it, source stays null.
      sourceNpcId: sourceNpcId && sourceNpcId !== npcId ? sourceNpcId : null,
      kind,
      description: text,
      claim: clean(claim, 180),
      confidence: Math.min(1, Math.max(0, Number(confidence) || 0.5)),
      importance: Math.min(1, Math.max(0, Number(importance) || 0.5)),
      context: clean(context, 160),
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

  // Examine a finished conversation and keep at most six things from it.
  function consider(session, {
    profileA,
    profileB,
    relationshipChanges = [],
    news = null,
    disagreement = false,
    socialSeeds = [],
  } = {}) {
    const created = [];
    const a = session.participants[0];
    const b = session.participants[1];
    const conv = session.id;
    const when = new Date(now()).toISOString();

    const add = (args) => {
      if (created.length >= 6) return null;
      const memory = remember({ ...args, conversationId: conv });
      if (memory) created.push(memory);
      return memory;
    };

    const recordAB = relationshipChanges.find((change) => change.npcId === a.id);
    const firstMeeting = !recordAB || recordAB.interactions === 1;

    if (firstMeeting && created.length < 6) {
      add({
        npcId: a.id,
        aboutNpcId: b.id,
        kind: 'milestone',
        description: `Met ${b.name} for the first time and had a proper talk.`,
        importance: 0.62,
        context: clean(firstLine(session)),
        dedupeKey: `first|${a.id}|${b.id}`,
      });
      add({
        npcId: b.id,
        aboutNpcId: a.id,
        kind: 'milestone',
        description: `Met ${a.name} for the first time and had a proper talk.`,
        importance: 0.62,
        context: clean(firstLine(session)),
        dedupeKey: `first|${b.id}|${a.id}`,
      });
    }

    // A shared interest is worth remembering: it is what makes friends out of
    // neighbours, and it is a concrete thing to bring up next time.
    const interestsA = new Set((profileA && profileA.interests ? profileA.interests : []).map((entry) => entry.toLowerCase()));
    const topics = (profileB && profileB.interests ? profileB.interests : []).filter((entry) => interestsA.has(entry.toLowerCase()));
    if (topics.length && created.length < 6) {
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

    if (disagreement && created.length < 6) {
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

    if (news && news.headline && created.length < 6) {
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

    // Third-party claims are the heart of the social memory. The listener keeps what
    // they heard, including the source, so it can be retold, doubted or used later.
    for (const seed of socialSeeds || []) {
      if (created.length >= 6) break;
      if (!seed || !seed.speakerId || !seed.listenerId || !seed.subjectId) continue;
      if (![a.id, b.id].includes(seed.speakerId) || ![a.id, b.id].includes(seed.listenerId)) continue;
      const subject = seed.subjectId === seed.speakerId
        ? { id: seed.speakerId, name: seed.speakerName || seed.subjectName || a.name }
        : { id: seed.subjectId, name: seed.subjectName || seed.subjectId };
      const speakerName = seed.speakerId === a.id ? a.name : b.name;
      const listenerName = seed.listenerId === a.id ? a.name : b.name;
      const subjectName = subject.name;
      const claim = clean(seed.claim, 180);
      if (!claim) continue;

      // Only remember a claim the conversation actually touched. The offline writer
      // always names the subject; the model is asked to, and usually does.
      const engaged = (session.messages || []).some((message) => {
        const text = String(message.text || '').toLowerCase();
        return text.includes(String(subjectName).toLowerCase())
          || text.includes(claim.slice(0, 24).toLowerCase());
      });
      if (!engaged) continue;

      const kind = socialKind(seed);
      const aboutId = kind === 'secret' ? seed.speakerId : seed.subjectId;
      const aboutName = kind === 'secret' ? speakerName : subjectName;
      const description = socialDescription(seed, speakerName, subjectName);
      const listener = seed.listenerId === a.id ? a : b;
      const source = seed.sourceNpcId || seed.speakerId;
      add({
        npcId: listener.id,
        aboutNpcId: aboutId,
        sourceNpcId: source,
        kind,
        description,
        claim,
        confidence: seed.confidence || 0.5,
        importance: kind === 'secret' ? 0.88 : kind === 'grudge' ? 0.82 : kind === 'rumor' ? 0.7 : 0.58,
        context: `${seed.title || 'a conversation'} · ${listenerName} heard it from ${speakerName}`,
        dedupeKey: `social|${listener.id}|${aboutId}|${kind}|${hash(claim)}`,
      });

      // A confidence is also a thing the speaker chose to do. Keeping that memory
      // lets them wonder later whether they should have said it.
      if (kind === 'secret') {
        add({
          npcId: seed.speakerId,
          aboutNpcId: seed.listenerId,
          kind: 'secret',
          description: `Told ${listenerName} something private. They have not repeated it yet.`,
          claim,
          confidence: 0.9,
          importance: 0.7,
          context: 'a confidence',
          dedupeKey: `told|${seed.speakerId}|${seed.listenerId}|${hash(claim)}`,
        });
      } else if (seed.sourceName) {
        // Passing on someone else's claim is its own small act of gossip.
        add({
          npcId: seed.speakerId,
          aboutNpcId: seed.subjectId,
          sourceNpcId: seed.sourceNpcId,
          kind: 'gossip',
          description: `Told ${listenerName} what ${seed.sourceName} said about ${subjectName}.`,
          claim,
          confidence: seed.confidence || 0.45,
          importance: 0.52,
          context: seed.title || 'a conversation',
          dedupeKey: `gossip|${seed.speakerId}|${seed.listenerId}|${hash(claim)}`,
        });
      }
    }

    // Some social memories are not third-party claims. A promise is a thing one
    // villager now expects from the other; a witnessed moment is first-hand, not
    // gossip. Both are small enough to extract from the line that carried them.
    const byId = new Map([[a.id, a], [b.id, b]]);
    const messages = session.messages || [];
    const speakerOf = (message) => byId.get(message.speakerId) || null;
    const otherOf = (speaker) => (speaker && speaker.id === a.id ? b : a);

    const promiseLine = messages.find((message) => /\b(promise|i will|i won't|i'll)\b/i.test(String(message.text || '')));
    if (promiseLine && created.length < 6) {
      const speaker = speakerOf(promiseLine);
      const other = otherOf(speaker);
      const quote = clean(promiseLine.text, 110);
      if (speaker && other && quote) {
        add({
          npcId: other.id,
          aboutNpcId: speaker.id,
          kind: 'promise',
          description: `${speaker.name} promised: ${quote}`,
          claim: quote,
          confidence: 0.85,
          importance: 0.72,
          context: 'a promise',
          dedupeKey: `promise|${other.id}|${speaker.id}|${hash(quote)}`,
        });
        add({
          npcId: speaker.id,
          aboutNpcId: other.id,
          kind: 'promise',
          description: `Promised ${other.name}: ${quote}`,
          claim: quote,
          confidence: 0.85,
          importance: 0.7,
          context: 'a promise',
          dedupeKey: `promise|${speaker.id}|${other.id}|${hash(quote)}`,
        });
      }
    }

    const witnessLine = messages.find((message) => /\bi (saw|watched)\b/i.test(String(message.text || '')));
    if (witnessLine && created.length < 6) {
      const speaker = speakerOf(witnessLine);
      const other = otherOf(speaker);
      const quote = clean(witnessLine.text, 110);
      if (speaker && other && quote) {
        add({
          npcId: speaker.id,
          aboutNpcId: other.id,
          kind: 'witnessed',
          description: `Saw ${other.name} while we talked: ${quote}`,
          claim: quote,
          confidence: 0.95,
          importance: 0.68,
          context: 'something I saw myself',
          dedupeKey: `witnessed|${speaker.id}|${other.id}|${hash(quote)}`,
        });
      }
    }

    const insultLine = messages.find((message) => /\b(idiot|stupid|liar|pathetic|useless|shut up|fool)\b/i.test(String(message.text || '')));
    if (insultLine && created.length < 6) {
      const speaker = speakerOf(insultLine);
      const other = otherOf(speaker);
      const quote = clean(insultLine.text, 110);
      if (speaker && other && quote) {
        add({
          npcId: other.id,
          aboutNpcId: speaker.id,
          kind: 'negative',
          description: `${speaker.name} insulted me: ${quote}`,
          claim: quote,
          confidence: 0.95,
          importance: 0.8,
          context: 'an insult',
          dedupeKey: `insult|${other.id}|${speaker.id}|${hash(quote)}`,
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

  // Exact subject lookup, used by the social-focus layer. recall() is ranked for a
  // prompt and may legitimately leave out the one claim that is about this person.
  function forAbout(npcId, aboutId, { limit = 8 } = {}) {
    loadFor(npcId).catch(() => {});
    return list
      .filter((memory) => memory.npcId === npcId && memory.aboutNpcId === aboutId)
      .sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0)
        || String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit);
  }

  function claims(npcId, { limit = 8 } = {}) {
    loadFor(npcId).catch(() => {});
    return list
      .filter((memory) => memory.npcId === npcId && SOCIAL_MEMORY_KINDS.has(memory.kind))
      .sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0)
        || String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit);
  }

  loadLocal();

  return {
    remember,
    consider,
    recall,
    forAbout,
    claims,
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
