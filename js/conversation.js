// The conversation manager.
//
// This is the one place that coordinates a conversation: who starts it, who speaks
// next, how many messages it runs to, when it ends, and what it leaves behind in the
// relationship and memory stores. Movement, facing, distance, pacing and the talking
// state itself belong to js/lifestyle.js, which calls begin()/update() and gets both
// villagers handed back when the chat is over.
//
// The model is asked for one line at a time and never sees the clock, the map or the
// message limit as something it can change.

import { contextFor, profileFor } from './personalities.js';
import { createOfflineDialogue } from './offline_dialogue.js';
import { createDialogueCache } from './dialogue_cache.js';

// A chat is never padded to a length. Two villagers with nothing new to say part ways
// after a couple of turns; one with a real thread to pull can run to eight.
const MIN_TURNS = 2;
const MAX_TURNS = 8;

// What villagers actually talk about. The village itself is deliberately absent: ten
// people discussing the square every day is what made every conversation sound alike.
// One of these is drawn per conversation and offered to the model as a subject.
export const TOPICS = [
  'the last film you watched and why it stuck with you',
  'a song from years ago you cannot get out of your head',
  'the price of everything and who is getting rich',
  'a meal someone used to cook for you',
  'the strangest dream you had this week',
  'the sea and whether you would ever live by it',
  'a dog or cat that follows you about',
  'money you lent someone and never got back',
  'whether it is worth being famous',
  'an old scar and the story behind it',
  'what you would do with a free month',
  'a job you nearly took and regret',
  'the moon and how it looks bigger some nights',
  'a bet you lost',
  'the worst haircut you ever had',
  'something you heard on the radio that you cannot explain',
  'a person you miss and have never said so out loud',
  'a machine in the city that talks back to you',
  'a lie you told that got out of hand',
  'a door that only seems to open at night',
  'the word home and what it means to you',
  'why cats stare at nothing',
  'the fastest you have ever run',
  'a letter you never sent',
  'whether people can really change',
  'the best thing you have ever eaten',
  'a town you passed through once and never forgot',
  'what you would say to someone who is gone',
  'a habit you cannot break',
  'the noise the city makes at three in the morning',
];
const APPROACH_LIMIT = 12; // seconds the pair may take to reach each other
const SESSION_LIMIT = 95; // hard cap, so a stalled request cannot freeze a villager
const MAX_FAILURES = 3; // consecutive model failures before the chat is closed
const LOG_LIMIT = 40;

const CATEGORY_COOLDOWN = {
  'best friend': 45,
  'close friend': 60,
  friend: 80,
  friendly: 110,
  acquaintance: 130,
  neutral: 150,
  stranger: 170,
  disliked: 360,
  enemy: 780,
};

// How long a bubble stays up: long enough for the typewriter to finish, plus a moment
// to read it. Line breaks do not count, since they cost no speaking time.
function displayMs(text) {
  const length = String(text || '').replace(/\s+/g, ' ').trim().length;
  return Math.min(6800, Math.max(2400, 1000 + length * 55));
}

// "Not word for word, but the same point again" is what makes a village feel empty.
// A line that mostly reuses the words of something already said adds nothing, so the
// next request is steered to a goodbye instead of another lap around the subject.
const STOP_WORDS = new Set([
  'the', 'and', 'that', 'this', 'with', 'have', 'has', 'had', 'you', 'your', 'yours',
  'for', 'but', 'not', 'are', 'was', 'were', 'they', 'them', 'then', 'there', 'here',
  'what', 'when', 'who', 'why', 'how', 'just', 'like', 'about', 'from', 'into', 'been',
  'being', 'would', 'could', 'should', 'will', 'shall', 'does', 'did', 'his', 'her',
  'its', 'our', 'their', 'him', 'she', 'too', 'very', 'much', 'some', 'any', 'all',
  'one', 'two', 'also', 'say', 'says', 'said', 'know', 'think', 'well', 'yeah', 'yes',
]);

function contentWords(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
}

function repeatsEarlier(session, text) {
  const candidate = new Set(contentWords(text));
  // a short line carries too little meaning to judge, and "Fair enough" twice is
  // normal speech rather than a villager going in circles
  if (candidate.size < 3) return false;
  for (const message of session.messages) {
    const previous = new Set(contentWords(message.text));
    if (previous.size < 3) continue;
    let shared = 0;
    for (const word of candidate) if (previous.has(word)) shared += 1;
    if (shared / Math.min(candidate.size, previous.size) >= 0.66) return true;
  }
  return false;
}

// A short goodbye is a legitimate ending: nothing is gained by restating a point both
// of them already made.
const FAREWELL = /\b(goodbye|bye|see you|see ya|take care|talk later|talk soon|catch you|until later|good day|good night|i should go|let you go|back to it|off you go|another time|that is all|that's all)\b/i;

function isFarewell(text) {
  const value = String(text || '').trim();
  return value.length > 0 && value.length <= 140 && FAREWELL.test(value);
}

// Getting properly cross is part of life, not a fault in the simulation. Two sharp lines
// in a row is a row rather than a conversation, and the relationship records pay for it
// when the session is scored.
const ANGER = /\b(shut up|idiot|stupid|hate you|liar|pathetic|nonsense|rubbish|fool|get lost|grow up|you never|you always|useless|keep your mouth shut)\b/i;

export function createConversations({
  roster = [],
  ai,
  relationships,
  memories,
  news,
  rng = Math.random,
  onHandBack = null,
  onEnd = null,
  // Optional overrides, mostly for the tests: the engine and the cache are created
  // here when the village does not hand its own in.
  offline = null,
  cache = null,
  // The clock and the weather, read fresh for every line. The simulation owns both;
  // this module only borrows them for what a villager would notice.
  environment = null,
} = {}) {
  const sessions = new Map();
  const recent = [];
  const pairCooldowns = new Map();
  const recentOpeners = new Map();
  const stats = {
    started: 0,
    completed: 0,
    abandoned: 0,
    failed: 0,
    messages: 0,
    groqMessages: 0,
    cachedMessages: 0,
    offlineMessages: 0,
    lastError: null,
  };
  let counter = 0;
  const recentTopics = [];

  // Where a line came from, in order of preference: the model, a line the model wrote
  // before for a comparable moment, then the procedural engine. The last one cannot
  // fail, so a conversation never depends on Groq being up.
  const dialogue = offline || createOfflineDialogue({ rng });
  const dialogueCache = cache || createDialogueCache();
  const sources = { groq: 0, cached: 0, offline: 0 };

  function environmentNow() {
    try {
      const env = environment ? environment() : {};
      return {
        timeOfDay: (env && env.timeOfDay) || 'day',
        weather: (env && env.weather) || null,
      };
    } catch {
      return { timeOfDay: 'day', weather: null };
    }
  }

  function activityOf(npc) {
    if (!npc || !npc.sim) return '';
    if (npc.room) return 'inside';
    return npc.sim.state || '';
  }

  // What this speaker remembers about that one, shared moments first. A villager with
  // no stored memories still has their own history to draw on.
  function memoryContext(speakerEntry, listenerEntry) {
    const recalled = memories ? memories.recall(speakerEntry.id, listenerEntry.id, { limit: 4 }) : [];
    const list = recalled.map((memory) => ({
      description: memory.description,
      aboutNpcId: memory.aboutNpcId || null,
    }));
    if (!list.length) {
      for (const line of profileFor(speakerEntry).memories || []) {
        list.push({ description: line, aboutNpcId: null });
      }
    }
    return list;
  }

  function currentMode() {
    const available = ai && ai.availability ? ai.availability() : { available: !!(ai && ai.status && ai.status().configured) };
    if (available.available) return 'groq';
    if (dialogueCache.size() > 0) return 'cached';
    return 'offline';
  }

  function dialogueStatus() {
    const availability = ai && ai.availability ? ai.availability() : { configured: false, available: false, fallback: true };
    const mode = currentMode();
    return {
      mode,
      fallback: mode !== 'groq',
      groq: availability,
      counts: { ...sources },
      cache: dialogueCache.status(),
      offline: dialogue.status(),
      lastError: stats.lastError,
    };
  }

  // Never the same subject twice in a row, so a pair that meets often still has
  // something new to bring up.
  function pickTopic() {
    const pool = TOPICS.filter((candidate) => !recentTopics.includes(candidate) && dialogue.topicReady(candidate));
    const topic = pool[Math.floor(rng() * pool.length)] || TOPICS[0];
    recentTopics.push(topic);
    if (recentTopics.length > 8) recentTopics.shift();
    // The engine keeps its own ninety-minute topic cooldown, which outlives the
    // eight-topic window, so a subject does not come back the moment it falls out.
    dialogue.noteTopic(topic);
    return topic;
  }

  // Some conversations are simply not going to go well, and that is a feature: a
  // village where nobody ever falls out is a village with nothing at stake. The chance
  // is real for everyone and rises with old dislike and coldness between the pair.
  function tensionChance(aId, bId) {
    if (!relationships) return 0.3;
    const ab = relationships.record(aId, bId);
    const ba = relationships.record(bId, aId);
    const dislike = ((Number(ab.dislike) || 0) + (Number(ba.dislike) || 0)) / 2;
    const warmth = ((Number(ab.score) || 0) + (Number(ba.score) || 0)) / 200;
    const cold = warmth < 0 ? -warmth : 0;
    return Math.min(0.75, Math.max(0.18, 0.3 + dislike * 0.4 + cold * 0.25));
  }

  const entryFor = (npc) => {
    const id = npc && npc.config ? npc.config.id : null;
    return roster.find((entry) => entry.id === id) || null;
  };

  const nameFor = (id) => {
    const entry = roster.find((candidate) => candidate.id === id);
    return entry ? entry.name : id;
  };

  const pairKey = (aId, bId) => [aId, bId].sort().join('|');

  function cooldownFor(session) {
    const a = session.participants[0].id;
    const b = session.participants[1].id;
    const category = relationships ? relationships.record(a, b).category : 'stranger';
    const base = CATEGORY_COOLDOWN[category] || 150;
    const profileA = profileFor(entryFor(session.npcA) || {});
    const profileB = profileFor(entryFor(session.npcB) || {});
    // sociable villagers recover faster, and friends drift back together sooner
    const sociability = 1 - ((profileA.social.sociability + profileB.social.sociability) / 2) * 0.4;
    return Math.round(base * sociability * (0.8 + rng() * 0.4));
  }

  function canTalk(npcA, npcB) {
    if (!npcA || !npcB || !npcA.config || !npcB.config) return false;
    const key = pairKey(npcA.config.id, npcB.config.id);
    const until = pairCooldowns.get(key) || 0;
    return Date.now() >= until;
  }

  function begin(npcA, npcB) {
    if (!canTalk(npcA, npcB)) return null;
    const a = entryFor(npcA);
    const b = entryFor(npcB);
    if (!a || !b) return null;

    counter += 1;
    const target = MIN_TURNS + Math.floor(rng() * (MAX_TURNS - MIN_TURNS + 1));
    // Every chat gets its own subject, so two villagers who talk every day do not
    // circle the same ground; some also start already annoyed with each other.
    const topic = pickTopic();
    const mood = rng() < tensionChance(a.id, b.id) ? 'tense' : 'calm';

    const profileA = profileFor(a);
    const profileB = profileFor(b);
    // only villagers who actually care about the news ever bring one up
    const headline = news ? (news.pick(profileA) || news.pick(profileB)) : null;

    const session = {
      id: `c_${Date.now().toString(36)}_${counter.toString(36)}`,
      npcA,
      npcB,
      participants: [
        { id: a.id, name: a.name },
        { id: b.id, name: b.name },
      ],
      initiatorId: a.id,
      responderId: b.id,
      startedAt: new Date().toISOString(),
      endedAt: null,
      target,
      topic,
      mood,
      status: 'active',
      messages: [],
      errors: [],
      clock: 0,
      wait: 0,
      pending: false,
      pendingSince: 0,
      nextAt: 0,
      failures: 0,
      relationshipAtStart: [
        { ...relationships.record(a.id, b.id) },
        { ...relationships.record(b.id, a.id) },
      ],
      relationshipChanges: [],
      memories: [],
      news: headline ? [headline] : [],
      outcome: null,
      closeReason: null,
      followUps: [],
      lastSource: null,
      categories: [],
    };

    sessions.set(session.id, session);
    stats.started += 1;
    return session;
  }

  // One turn is one request to the model. A line that had to be split into a follow-up
  // message stays part of the same turn, so the villagers keep alternating speakers.
  const turns = (session) => session.messages.filter((message) => !message.extra).length;

  function addMessage(session, speakerId, text, generatedBy, closing, extra = false) {
    const message = {
      id: `${session.id}_${session.messages.length + 1}`,
      speakerId,
      speakerName: nameFor(speakerId),
      text,
      at: new Date().toISOString(),
      number: session.messages.length + 1,
      generatedBy,
      closing: !!closing,
      extra: !!extra,
    };
    session.messages.push(message);
    // the simulation clock is in seconds, so the reading time has to be converted
    session.nextAt = session.clock + displayMs(text) / 1000;
    stats.messages += 1;
    if (generatedBy === 'groq') stats.groqMessages += 1;
    else if (generatedBy === 'cached') stats.cachedMessages += 1;
    else stats.offlineMessages += 1;

    const npc = speakerId === session.participants[0].id ? session.npcA : session.npcB;
    if (npc && npc.sim) npc.sim.dialogue = text;
    return message;
  }

  function payloadFor(session, mode, speakerId) {
    const isA = speakerId === session.participants[0].id;
    const speakerEntry = isA ? entryFor(session.npcA) : entryFor(session.npcB);
    const listenerEntry = isA ? entryFor(session.npcB) : entryFor(session.npcA);
    if (!speakerEntry || !listenerEntry) return null;

    const speakerCtx = contextFor(speakerEntry);
    const memoryList = memories
      ? memories.recall(speakerEntry.id, listenerEntry.id, { limit: 4 }).map((memory) => ({
        description: memory.description,
        aboutName: memory.aboutNpcId ? nameFor(memory.aboutNpcId) : null,
        kind: memory.kind,
        importance: memory.importance,
      }))
      : [];

    return {
      conversationId: session.id,
      mode,
      topic: session.topic || '',
      mood: session.mood || 'calm',
      messageCount: turns(session),
      speaker: speakerCtx,
      listener: contextFor(listenerEntry),
      history: session.messages.map((message) => ({
        speakerId: message.speakerId,
        speakerName: message.speakerName,
        text: message.text,
      })),
      memories: memoryList,
      relationship: relationships ? relationships.record(speakerEntry.id, listenerEntry.id) : null,
      relationshipChange: session.changeNote || null,
      news: session.news.map((item) => ({
        headline: item.headline,
        summary: item.summary,
        category: item.category,
      })),
      recentLines: (recentOpeners.get(speakerEntry.id) || []).slice(-3),
    };
  }

  async function requestLine(session) {
    if (session.pending || session.status !== 'active') return;
    const turn = turns(session);
    const isA = turn % 2 === 0;
    const speakerId = isA ? session.participants[0].id : session.participants[1].id;
    const mode = turn === 0
      ? 'opening'
      : turn >= session.target - 1 ? 'closing' : 'reply';

    const payload = payloadFor(session, mode, speakerId);
    if (!payload) {
      finish(session, 'failed', 'no_profile');
      return;
    }

    session.pending = true;
    session.pendingSince = session.clock;

    const speakerEntry = isA ? entryFor(session.npcA) : entryFor(session.npcB);
    const listenerEntry = isA ? entryFor(session.npcB) : entryFor(session.npcA);
    const profile = profileFor(speakerEntry || {});
    const otherProfile = profileFor(listenerEntry || {});
    const env = environmentNow();

    let parts = [];
    let source = null;

    // 1. The model, when it is configured and not cooling down after a failure.
    //    A cooldown is skipped silently: the village is not in an error state.
    const canAsk = ai && (!ai.canGenerate || ai.canGenerate());
    if (canAsk) {
      // One retry only when the model repeats the speaker's own previous line: that is
      // the failure mode a small model actually has, and it is not worth a third call.
      let result = await ai.generate(payload);
      if (session.status !== 'active') return;
      const ownLast = [...session.messages].reverse().find((message) => message.speakerId === speakerId);
      if (result.ok && ownLast && ownLast.text.trim() === result.text.trim()) {
        const retry = await ai.generate(payload);
        if (session.status !== 'active') return;
        if (retry.ok) result = retry;
      }

      if (result.ok) {
        session.failures = 0;
        source = 'groq';
        // The model is asked to fit one bubble. When it still runs over, the rest is
        // spoken as another message after this one instead of being cut off.
        parts = [result.text, ...(Array.isArray(result.extra) ? result.extra : [])].filter(Boolean);
        // Keep the good lines: when the model goes away, the cache is the next rung.
        dialogueCache.remember({
          text: parts[0],
          mode,
          mood: session.mood,
          topic: session.topic,
          weatherKey: env.weather ? env.weather.key : '',
          timeOfDay: env.timeOfDay,
          category: mode,
        });
      } else if (result.error) {
        session.errors.push({
          at: new Date().toISOString(),
          code: result.error.code,
          message: result.error.message,
          mode,
        });
        // A long outage should not grow a session's error list without limit.
        if (session.errors.length > 12) session.errors.shift();
        stats.lastError = session.errors[session.errors.length - 1];
      }
    }

    session.pending = false;

    // 2. A line the model produced before for a comparable moment.
    if (!parts.length && session.mood !== 'tense') {
      const cached = dialogueCache.take({
        mode,
        mood: session.mood,
        topic: session.topic,
        weatherKey: env.weather ? env.weather.key : '',
        timeOfDay: env.timeOfDay,
        category: mode,
        avoid: session.messages.map((message) => message.text).slice(-8),
      });
      if (cached) {
        parts = [cached];
        source = 'cached';
      }
    }

    // 3. The procedural engine. It cannot fail, which is what makes the village
    //    independent of Groq rather than merely resilient to it.
    if (!parts.length) {
      const spoken = dialogue.line({
        me: profile,
        them: otherProfile,
        relationship: relationships ? relationships.record(speakerEntry.id, listenerEntry.id) : null,
        memories: memoryContext(speakerEntry, listenerEntry),
        mode,
        mood: session.mood,
        weather: env.weather,
        timeOfDay: env.timeOfDay,
        news: session.news[0] || null,
        topic: session.topic,
        activity: activityOf(isA ? session.npcA : session.npcB),
        recentLines: session.messages.map((message) => message.text).slice(-6),
      });
      parts = [spoken.text];
      source = 'offline';
      session.categories.push(spoken.category);
    }

    if (!parts.length) return;
    sources[source] += 1;
    session.lastSource = source;

    // Nothing new to say: wrap the conversation up instead of letting them circle the
    // same point. The cached and procedural paths already avoid repeats, so this guard
    // applies to the model, which is the one likely to restate itself.
    if (source === 'groq' && mode !== 'closing' && turns(session) >= 2 && repeatsEarlier(session, parts[0])) {
      session.target = turns(session) + 1;
      session.repeats = (session.repeats || 0) + 1;
      return;
    }

    // Follow-ups are a model-only shape: the offline engine always speaks one bubble.
    session.followUps = source === 'groq'
      ? parts.slice(1).map((text, index) => ({
        speakerId,
        text,
        closing: mode === 'closing' && index === parts.length - 2,
      }))
      : [];

    // a goodbye is the last thing said, so the pair can get back to their day
    const farewell = mode !== 'opening' && isFarewell(parts[0]);
    addMessage(session, speakerId, parts[0], source, (mode === 'closing' || farewell) && !session.followUps.length);
    if (farewell) {
      finish(session, 'complete', 'said_goodbye');
      return;
    }
    // Two sharp lines in a row: they have had the argument they were going to have,
    // so it ends there rather than smouldering for another four turns.
    if (session.mood === 'tense' && mode !== 'closing' && turns(session) >= 2
      && !session.followUps.length
      && session.messages.slice(-2).every((message) => ANGER.test(message.text))) {
      finish(session, 'complete', 'argument');
      return;
    }
    if (mode === 'opening' && source === 'groq') {
      const list = recentOpeners.get(speakerId) || [];
      list.push(parts[0]);
      if (list.length > 4) list.shift();
      recentOpeners.set(speakerId, list);
    }
  }

  function finish(session, outcome, reason = null) {
    if (!session || session.status !== 'active') return;
    session.status = outcome;
    session.outcome = outcome;
    session.closeReason = reason;
    session.endedAt = new Date().toISOString();
    sessions.delete(session.id);

    // Whatever happens next, neither villager keeps a reference to a session that is
    // no longer running - a stale reference is what would leave a pair stuck facing
    // each other with nobody driving the conversation.
    for (const npc of [session.npcA, session.npcB]) {
      if (npc && npc.sim && npc.sim.session === session) npc.sim.session = null;
    }

    const aId = session.participants[0].id;
    const bId = session.participants[1].id;
    pairCooldowns.set(pairKey(aId, bId), Date.now() + cooldownFor(session) * 1000);

    if (outcome === 'complete') stats.completed += 1;
    else if (outcome === 'failed') stats.failed += 1;
    else stats.abandoned += 1;

    // What the conversation left behind. A chat that never got past one line, or one
    // that failed outright, does not move a relationship.
    const realExchange = turns(session) >= 2 && (outcome === 'complete' || outcome === 'abandoned');
    if (realExchange) {
      const profileA = profileFor(entryFor(session.npcA) || {});
      const profileB = profileFor(entryFor(session.npcB) || {});
      const disagreement = session.mood === 'tense'
        || session.messages.some((message) => ANGER.test(message.text));
      const result = relationships ? relationships.applyConversation(session, {
        profileA,
        profileB,
        disagreement,
        newsUsed: session.news.length > 0 && session.messages.some((message) => /news|headline|heard/i.test(message.text)),
      }) : null;
      session.relationshipChanges = result ? result.changes : [];
      session.tone = result ? result.tone : 0;
      if (memories) {
        session.memories = memories.consider(session, {
          profileA,
          profileB,
          relationshipChanges: session.relationshipChanges,
          news: session.news[0] || null,
          disagreement,
        });
      }
    }

    const dialogueClear = [session.npcA, session.npcB];
    for (const npc of dialogueClear) {
      if (npc && npc.sim && npc.sim.dialogue && session.clock > 0) {
        // leave the last line visible for a moment, then let the day continue
        setTimeout(() => {
          if (npc.sim && npc.sim.state !== 'talking') npc.sim.dialogue = null;
        }, 1600);
      }
    }

    recent.unshift(session);
    if (recent.length > LOG_LIMIT) recent.length = LOG_LIMIT;

    // Handing both back is always correct: a villager whose state has already moved
    // on keeps that state, and a villager still standing in the chat gets a fresh
    // plan. Skipping this is how a pair ends up frozen mid-conversation.
    if (onHandBack) {
      onHandBack(session.npcA);
      onHandBack(session.npcB);
    }
    if (onEnd) onEnd(session);
  }

  function abandon(session, reason) {
    finish(session, 'abandoned', reason);
  }

  function update(dt) {
    if (!sessions.size) return;
    const step = Math.min(0.5, Math.max(0, dt));
    for (const session of [...sessions.values()]) {
      session.clock += step;

      const a = session.npcA;
      const b = session.npcB;
      if (!a || !b || !a.sim || !b.sim) {
        finish(session, 'abandoned', 'missing_villager');
        continue;
      }
      // someone walked away, went to bed, or the editor froze the village
      const stillTalking = a.sim.state === 'talking' && b.sim.state === 'talking'
        && a.sim.partner === b && b.sim.partner === a;
      if (!stillTalking) {
        finish(session, 'abandoned', 'participant_left');
        continue;
      }

      const gap = Math.hypot(b.x - a.x, b.y - a.y);
      if (gap > 20) {
        session.wait += step;
        if (session.wait > APPROACH_LIMIT) finish(session, 'abandoned', 'unreachable');
        continue;
      }
      if (session.wait > 0) session.wait = 0;

      if (session.clock > SESSION_LIMIT) {
        finish(session, 'complete', 'session_cap');
        continue;
      }
      if (session.pending) {
        // a request that never comes back must not hold two villagers hostage
        if (session.clock - session.pendingSince > 18) {
          session.pending = false;
          session.failures += 1;
          session.errors.push({
            at: new Date().toISOString(),
            code: 'stalled',
            message: 'The model request never came back.',
          });
          if (session.failures >= MAX_FAILURES) finish(session, 'failed', 'model_stalled');
        }
        continue;
      }

      if (turns(session) === 0) {
        requestLine(session);
        continue;
      }

      if (session.clock >= session.nextAt) {
        // a follow-up waits for the previous bubble to finish, so they never overlap
        if (session.followUps && session.followUps.length) {
          const next = session.followUps.shift();
          addMessage(session, next.speakerId, next.text, 'groq', next.closing, true);
          continue;
        }
        if (turns(session) >= session.target) {
          finish(session, 'complete', 'natural');
        } else {
          requestLine(session);
        }
      }
    }
  }

  function snapshotSession(session) {
    return {
      id: session.id,
      status: session.status,
      outcome: session.outcome,
      participants: session.participants.map((participant) => ({ ...participant })),
      initiatorId: session.initiatorId,
      responderId: session.responderId,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      target: session.target,
      topic: session.topic || null,
      mood: session.mood || 'calm',
      messages: session.messages.map((message) => ({ ...message })),
      messageCount: session.messages.length,
      relationshipChanges: session.relationshipChanges,
      relationshipAtStart: session.relationshipAtStart,
      memories: session.memories,
      news: session.news,
      errors: session.errors,
      closeReason: session.closeReason,
      pending: session.pending,
      followUps: (session.followUps || []).length,
      lastSource: session.lastSource || null,
      categories: (session.categories || []).slice(),
      // how long this chat has been running on the simulation clock, so the panel can
      // show progress and a stalled conversation is visible rather than silent
      clock: Number(session.clock.toFixed(1)),
      wait: Number(session.wait.toFixed(1)),
      tone: session.tone || 0,
    };
  }

  return {
    begin,
    canTalk,
    update,
    abandon,
    finish,
    active: () => [...sessions.values()].map(snapshotSession),
    activeCount: () => sessions.size,
    recent: () => recent.map(snapshotSession),
    all: () => [...recent.map(snapshotSession), ...[...sessions.values()].map(snapshotSession)],
    byId: (id) => {
      const session = sessions.get(id) || recent.find((item) => item.id === id);
      return session ? snapshotSession(session) : null;
    },
    stats: () => ({ ...stats, active: sessions.size, cooldowns: pairCooldowns.size }),
    // Which dialogue path is live right now, and what each one has produced. This is
    // what the debug panel reads: the mode is never hidden from the reader.
    mode: currentMode,
    dialogueStatus,
    // exposed so the debug panel can explain why this pair is quiet
    cooldownRemaining: (aId, bId) => Math.max(0, Math.round(((pairCooldowns.get(pairKey(aId, bId)) || 0) - Date.now()) / 1000)),
    resetCooldowns: () => pairCooldowns.clear(),
  };
}
