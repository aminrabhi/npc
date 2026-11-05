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
import { offlineLine } from './ai.js';

const MIN_MESSAGES = 5;
const MAX_MESSAGES = 10;
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

export function createConversations({
  roster = [],
  ai,
  relationships,
  memories,
  news,
  rng = Math.random,
  onHandBack = null,
  onEnd = null,
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
    offlineMessages: 0,
    lastError: null,
  };
  let counter = 0;

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
    const target = MIN_MESSAGES + Math.floor(rng() * (MAX_MESSAGES - MIN_MESSAGES + 1));

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
    const profile = profileFor(speakerEntry || {});

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

    session.pending = false;

    if (result.ok) {
      session.failures = 0;
      // The model is asked to fit one bubble. When it still runs over, the rest is
      // spoken as another message after this one instead of being cut off.
      const parts = [result.text, ...(Array.isArray(result.extra) ? result.extra : [])].filter(Boolean);
      session.followUps = parts.slice(1).map((text, index) => ({
        speakerId,
        text,
        closing: mode === 'closing' && index === parts.length - 2,
      }));
      addMessage(session, speakerId, parts[0], 'groq', mode === 'closing' && !session.followUps.length);
      if (mode === 'opening') {
        const list = recentOpeners.get(speakerId) || [];
        list.push(result.text);
        if (list.length > 4) list.shift();
        recentOpeners.set(speakerId, list);
      }
      return;
    }

    session.failures += 1;
    session.errors.push({
      at: new Date().toISOString(),
      code: result.error ? result.error.code : 'unknown',
      message: result.error ? result.error.message : 'generation failed',
      mode,
    });
    stats.lastError = session.errors[session.errors.length - 1];

    if (session.failures >= MAX_FAILURES) {
      finish(session, 'failed', 'model_unavailable');
      return;
    }

    // The village keeps talking: a marked offline line fills the gap and the panel
    // shows exactly which lines came from the model and which did not.
    addMessage(session, speakerId, offlineLine(profile, { mode, rng }), 'offline', mode === 'closing');
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
      const disagreement = session.messages.some((message) => /\b(shut up|idiot|stupid|hate you|liar|pathetic)\b/i.test(message.text));
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
    // exposed so the debug panel can explain why this pair is quiet
    cooldownRemaining: (aId, bId) => Math.max(0, Math.round(((pairCooldowns.get(pairKey(aId, bId)) || 0) - Date.now()) / 1000)),
    resetCooldowns: () => pairCooldowns.clear(),
  };
}
