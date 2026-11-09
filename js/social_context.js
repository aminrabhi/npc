// What two villagers have on their minds when they meet.
//
// The old conversation picker offered a generic subject such as “a bet you lost.”
// That produced talk about ideas and routines, but very little village. This layer
// starts from the other people: it chooses someone who is not standing in the
// conversation, finds the most alive thing the speaker thinks or has heard about
// them, and gives the dialogue engine a concrete angle.
//
// Angles are deliberately social rather than dramatic:
//   criticize  - something about the subject has been getting under their skin
//   defend     - the listener has a problem with the subject and the speaker does not
//   question   - the speaker is testing what the listener really thinks
//   rumour     - the speaker heard a claim and is passing it on
//   secret     - a confidence the speaker would only tell someone trusted
//   grudge     - an old slight that never got resolved
//   envy       - admiration the speaker will not admit to
//   observation- a small, specific thing they noticed
//
// The layer does not write dialogue. It produces a seed that both the model prompt and
// the offline writer can use, and that the memory layer can record afterwards.

import { CAST, opinionFor, bondsFor, bondTagsFor } from './cast.js';
import { profileFor } from './personalities.js';

const SOCIAL_KINDS = new Set([
  'opinion', 'rumor', 'grudge', 'secret', 'fact', 'witnessed', 'gossip', 'claim',
]);
const PAIR_HISTORY = 8;
const GLOBAL_HISTORY = 14;

const ANGLE_CATEGORY = {
  criticize: 'gossip',
  defend: 'defend',
  question: 'question',
  rumour: 'rumor',
  rumor: 'rumor',
  secret: 'secret',
  grudge: 'grudge',
  envy: 'envy',
  observation: 'gossip',
  compare: 'envy',
};

const ANGLE_INSTRUCTION = {
  criticize: 'You are not a fan of {subject}. Bring up something specific they have done, but do not announce that you dislike them. It should sound like a thing that has been sitting on your mind.',
  defend: 'You think people have been unfair to {subject}. Push back on it without turning the conversation into a lecture. You are defending a person, not winning an argument.',
  question: 'You want to know what {listener} really thinks of {subject}. Ask it sideways, like you are only making conversation. If the answer is evasive, notice that.',
  rumor: 'You heard this and it has been bothering you: {claim}. You are not certain it is true. Mention where it came from only if it fits naturally, and watch {listener} to see how they react.',
  secret: 'You trust {listener} enough to tell them something private: {claim}. Say it quietly and plainly, and ask them not to repeat it. Do not explain why you are telling them now.',
  grudge: 'You have not let this go: {claim}. It is not the official subject of the chat; it has leaked into it. Do not make a speech about it. Let it show in how you say the next thing.',
  envy: 'You would not admit that you envy {subject}. Compliment them in a way that sounds like a complaint. Underneath it, you want what they have.',
  compare: 'You are keeping score with {subject}. Bring it up as if you are being fair, even though you are not. Do not name the jealousy directly.',
  observation: 'You noticed something small and specific about {subject}. Bring it up as an observation, not a judgement. Let {listener} decide what it means.',
};

function clean(text, max = 160) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function categoryOf(record) {
  return record && record.category ? record.category : 'stranger';
}

function stanceText(record) {
  if (!record) return 'has not made up their mind';
  if (record.category === 'enemy') return 'cannot stand them';
  if (record.category === 'disliked') return 'does not like them';
  if (record.score >= 48) return 'is fond of them';
  if (record.score >= 18) return 'is friendly with them';
  if (record.score <= -10) return 'is cool towards them';
  return 'is still working them out';
}

function titleFor(angle, subjectName) {
  if (angle === 'rumour' || angle === 'rumor') return `a rumour about ${subjectName}`;
  if (angle === 'grudge') return `what ${subjectName} did`;
  if (angle === 'envy') return `the thing about ${subjectName}`;
  if (angle === 'defend') return `the case for ${subjectName}`;
  if (angle === 'secret') return 'a confidence';
  if (angle === 'question') return `what ${subjectName} is really like`;
  if (angle === 'compare') return `keeping score with ${subjectName}`;
  return `${subjectName}, apparently`;
}

function hashOf(text) {
  return hash(clean(text, 240).toLowerCase());
}

export function createSocialContext({
  roster = [],
  relationships = null,
  memories = null,
  rng = Math.random,
  now = () => Date.now(),
} = {}) {
  const pairHistory = new Map();
  const globalHistory = [];
  let counter = 0;

  const entryFor = (id) => roster.find((entry) => entry && entry.id === id) || null;
  const nameFor = (id) => {
    const entry = entryFor(id);
    if (entry && entry.name) return entry.name;
    return CAST[id] ? CAST[id].name : id;
  };
  const relationshipFor = (a, b) => {
    try {
      return relationships && relationships.record ? relationships.record(a, b) : null;
    } catch {
      return null;
    }
  };

  function pairKey(a, b) {
    return [a, b].sort().join('|');
  }

  function historyFor(a, b) {
    if (!pairHistory.has(pairKey(a, b))) pairHistory.set(pairKey(a, b), []);
    return pairHistory.get(pairKey(a, b));
  }

  function recentlyUsed(seedKey, a, b) {
    const local = historyFor(a, b);
    if (local.some((entry) => entry.key === seedKey)) return true;
    return false;
  }

  function recentlyUsedSubject(subjectId, a, b) {
    const local = historyFor(a, b);
    if (local.some((entry) => entry.subjectId === subjectId)) return true;
    // A subject may come back after the pair has talked about several other people.
    return globalHistory.slice(-4).filter((entry) => entry.subjectId === subjectId).length >= 2;
  }

  function markUsed(seed) {
    const local = historyFor(seed.speakerId, seed.listenerId);
    local.push({
      key: seed.id,
      subjectId: seed.subjectId,
      angle: seed.angle,
      at: now(),
    });
    if (local.length > PAIR_HISTORY) local.shift();
    globalHistory.push({ subjectId: seed.subjectId, at: now() });
    if (globalHistory.length > GLOBAL_HISTORY) globalHistory.shift();
  }

  function socialMemories(speakerId, subjectId) {
    if (!memories) return [];
    try {
      let list = [];
      if (memories.recall) {
        list = memories.recall(speakerId, subjectId, { limit: 8 }) || [];
      } else if (memories.for) {
        list = memories.for(speakerId) || [];
      }
      return list.filter((memory) => memory
        && memory.aboutNpcId === subjectId
        && SOCIAL_KINDS.has(memory.kind));
    } catch {
      return [];
    }
  }

  function listenerKnows(listenerId, speakerId, subjectId, claim) {
    if (!memories) return false;
    try {
      const list = memories.recall ? memories.recall(listenerId, subjectId, { limit: 8 }) : [];
      const key = hashOf(claim);
      return (list || []).some((memory) => memory
        && memory.aboutNpcId === subjectId
        && (memory.sourceNpcId === speakerId || hashOf(memory.claim || memory.description) === key));
    } catch {
      return false;
    }
  }

  function secretSeed(speakerId, listenerId, participantIds) {
    if (!relationships || !CAST[speakerId]) return null;
    const trust = Number((relationshipFor(listenerId, speakerId) || {}).trust) || 0;
    if (trust < 0.52) return null;
    const speaker = entryFor(speakerId);
    if (!speaker) return null;
    const profile = profileFor(speaker);
    const secret = clean(profile.secret, 180);
    if (!secret) return null;
    const known = listenerKnows(listenerId, speakerId, speakerId, secret);
    if (known) return null;
    // A confidence should feel rare. It is also how a close pair can become closer.
    if (rng() > 0.2) return null;
    const listener = entryFor(listenerId);
    if (!listener) return null;
    return {
      id: `secret|${speakerId}|${listenerId}|${hashOf(secret)}`,
      angle: 'secret',
      category: 'secret',
      speakerId,
      listenerId,
      subjectId: speakerId,
      subjectName: nameFor(speakerId),
      claim: secret,
      sourceId: speakerId,
      sourceName: nameFor(speakerId),
      confidence: 0.95,
      kind: 'secret',
      title: 'a confidence',
      instruction: ANGLE_INSTRUCTION.secret
        .replace(/\{listener\}/g, listener.name || 'them')
        .replace(/\{subject\}/g, speaker.name || 'them')
        .replace(/\{claim\}/g, secret),
      speakerStance: 'confiding',
      listenerStance: stanceText(relationshipFor(listenerId, speakerId)),
      participantIds: [...participantIds],
      turn: 0,
    };
  }

  function chooseSubject(speakerId, listenerId, participantIds) {
    const blocked = new Set([speakerId, listenerId, ...participantIds]);
    const candidates = roster.filter((entry) => entry && entry.id
      && !blocked.has(entry.id)
      && !entry.player
      && entry.id !== 'npc_11');
    if (!candidates.length) return null;

    const word = {};
    for (const entry of candidates) {
      const own = relationshipFor(speakerId, entry.id);
      const their = relationshipFor(listenerId, entry.id);
      const tags = bondTagsFor(speakerId, entry.id);
      const claims = socialMemories(speakerId, entry.id);
      let weight = 0.7;
      weight += Math.min(7, Math.abs(Number(own && own.score) || 0) / 10);
      weight += Math.min(5, Math.abs((Number(own && own.score) || 0) - (Number(their && their.score) || 0)) / 14);
      weight += tags.includes('grudges') ? 4 : 0;
      weight += tags.includes('envies') ? 3 : 0;
      weight += tags.includes('distrusts') ? 3 : 0;
      weight += tags.includes('dislikes') ? 2 : 0;
      weight += tags.includes('likes') ? 1.2 : 0;
      weight += claims.length ? 4 : 0;
      if (recentlyUsedSubject(entry.id, speakerId, listenerId)) weight *= 0.15;
      // Break ties without making the same person win every time.
      weight *= 0.8 + rng() * 0.4;
      word[entry.id] = Math.max(0.05, weight);
    }

    const total = Object.values(word).reduce((sum, value) => sum + value, 0);
    let roll = rng() * total;
    for (const entry of candidates) {
      roll -= word[entry.id];
      if (roll <= 0) return entry;
    }
    return candidates[candidates.length - 1];
  }

  function angleOptions(speakerId, listenerId, subject) {
    const own = relationshipFor(speakerId, subject.id);
    const their = relationshipFor(listenerId, subject.id);
    const tags = bondTagsFor(speakerId, subject.id);
    const opinion = opinionFor(speakerId, subject.id);
    const baseClaim = opinion ? opinion.note : (own && own.notes) || '';
    const ownScore = Number(own && own.score) || 0;
    const theirScore = Number(their && their.score) || 0;
    const options = [];

    const add = (angle, weight, extra = {}) => {
      if (weight > 0) options.push({ angle, weight, ...extra });
    };

    // A remembered claim is stronger than a standing opinion. It has a source and a
    // history, so retelling it is the most natural thing in the world.
    for (const memory of socialMemories(speakerId, subject.id)) {
      const claim = clean(memory.claim || memory.description, 180);
      if (!claim) continue;
      if (memory.sourceNpcId && memory.sourceNpcId === listenerId) continue;
      if (memory.kind === 'rumor') {
        add('rumor', 11, {
          claim,
          sourceId: memory.sourceNpcId || null,
          sourceName: memory.sourceNpcId ? nameFor(memory.sourceNpcId) : '',
          confidence: Number(memory.confidence) || 0.45,
          kind: 'rumor',
        });
      } else if (memory.kind === 'grudge') {
        add('grudge', 9, {
          claim,
          sourceId: memory.sourceNpcId || null,
          sourceName: memory.sourceNpcId ? nameFor(memory.sourceNpcId) : '',
          confidence: Number(memory.confidence) || 0.75,
          kind: 'grudge',
        });
      } else if (memory.kind === 'opinion' || memory.kind === 'claim') {
        add('criticize', 8, {
          claim,
          sourceId: memory.sourceNpcId || null,
          sourceName: memory.sourceNpcId ? nameFor(memory.sourceNpcId) : '',
          confidence: Number(memory.confidence) || 0.7,
          kind: 'opinion',
        });
      } else if (memory.kind === 'fact' || memory.kind === 'witnessed') {
        add('rumor', 5, {
          claim,
          sourceId: memory.sourceNpcId || null,
          sourceName: memory.sourceNpcId ? nameFor(memory.sourceNpcId) : '',
          confidence: Number(memory.confidence) || 0.8,
          kind: 'fact',
        });
      }
    }

    if (tags.includes('envies')) {
      add('envy', 10, { claim: baseClaim, kind: 'opinion', confidence: 0.6 });
    }
    if (tags.includes('grudges')) {
      add('grudge', 9, { claim: baseClaim, kind: 'grudge', confidence: 0.7 });
    }
    if (tags.includes('distrusts')) {
      add('question', 7, { claim: baseClaim, kind: 'opinion', confidence: 0.55 });
    }
    if (tags.includes('dislikes') || ownScore <= -12) {
      add('criticize', 7, { claim: baseClaim, kind: 'opinion', confidence: 0.65 });
    }
    if (ownScore >= 16 && theirScore <= -10) {
      add('defend', 9, { claim: baseClaim, kind: 'opinion', confidence: 0.6 });
    }
    if (ownScore >= 24) {
      add('defend', 3, { claim: baseClaim, kind: 'opinion', confidence: 0.5 });
    }
    if (their && Number(their.dislike) >= 0.35) {
      add('question', 5, { claim: baseClaim, kind: 'opinion', confidence: 0.5 });
    }
    if (baseClaim) {
      add('observation', 2.2, { claim: baseClaim, kind: 'opinion', confidence: 0.45 });
    }
    if (!options.length) {
      add('observation', 1, {
        claim: `${nameFor(subject.id)} has been on your mind lately.`,
        kind: 'opinion',
        confidence: 0.35,
      });
    }
    return options;
  }

  function chooseAngle(speakerId, listenerId, subject) {
    const options = angleOptions(speakerId, listenerId, subject);
    const total = options.reduce((sum, option) => sum + option.weight, 0);
    let roll = rng() * total;
    for (const option of options) {
      roll -= option.weight;
      if (roll <= 0) return option;
    }
    return options[options.length - 1];
  }

  function makeSeed(speakerId, listenerId, subject, option, participantIds) {
    const speaker = entryFor(speakerId);
    const listener = entryFor(listenerId);
    if (!speaker || !listener || !subject) return null;
    const subjectName = subject.name || nameFor(subject.id);
    const listenerName = listener.name || 'them';
    const claim = clean(option.claim || '', 180);
    if (!claim) return null;
    const sourceId = option.sourceId && option.sourceId !== speakerId ? option.sourceId : null;
    const sourceName = sourceId ? nameFor(sourceId) : '';
    const instruction = (ANGLE_INSTRUCTION[option.angle] || ANGLE_INSTRUCTION.observation)
      .replace(/\{subject\}/g, subjectName)
      .replace(/\{listener\}/g, listenerName)
      .replace(/\{claim\}/g, claim);
    const id = `social|${speakerId}|${listenerId}|${subject.id}|${option.angle}|${hashOf(claim)}`;
    const own = relationshipFor(speakerId, subject.id);
    const their = relationshipFor(listenerId, subject.id);
    return {
      id,
      angle: option.angle,
      category: ANGLE_CATEGORY[option.angle] || 'gossip',
      speakerId,
      listenerId,
      subjectId: subject.id,
      subjectName,
      claim,
      sourceId,
      sourceName,
      confidence: Number(option.confidence) || 0.5,
      kind: option.kind || 'opinion',
      title: titleFor(option.angle, subjectName),
      instruction,
      speakerStance: own ? own.category : 'stranger',
      listenerStance: their ? their.category : 'stranger',
      listenerTrust: Number(their && their.trust) || 0,
      speakerScore: Number(own && own.score) || 0,
      listenerScore: Number(their && their.score) || 0,
      tags: bondTagsFor(speakerId, subject.id),
      participantIds: [...participantIds],
    };
  }

  // Choose one social seed. The caller decides when a conversation needs a new one,
  // so pivots can happen without the dialogue layer knowing where the seed came from.
  function next({ speakerId, listenerId, participantIds = [], allowSecret = true } = {}) {
    if (!speakerId || !listenerId || speakerId === listenerId) return null;
    const allParticipants = [...new Set([...participantIds, speakerId, listenerId])];

    if (allowSecret) {
      const secret = secretSeed(speakerId, listenerId, allParticipants);
      if (secret && !recentlyUsed(secret.id, speakerId, listenerId)) {
        markUsed(secret);
        return secret;
      }
    }

    // Try a few subjects so a cooldown does not leave the conversation empty.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const subject = chooseSubject(speakerId, listenerId, allParticipants);
      if (!subject) return null;
      const option = chooseAngle(speakerId, listenerId, subject);
      const seed = makeSeed(speakerId, listenerId, subject, option, allParticipants);
      if (!seed) continue;
      if (recentlyUsed(seed.id, speakerId, listenerId)) continue;
      if (listenerKnows(listenerId, speakerId, subject.id, seed.claim) && seed.angle !== 'question') {
        // They already know this version. Let them compare notes instead of repeating
        // the same rumour as if it were new.
        seed.angle = 'observation';
        seed.category = 'gossip';
        seed.kind = 'opinion';
        seed.instruction = `You and ${entryFor(listenerId).name || 'they'} have both heard something about ${seed.subjectName}. Do not repeat the whole thing. Ask what they make of it now.`;
        seed.confidence = 0.55;
        seed.id = `${seed.id}|known`;
      }
      if (recentlyUsed(seed.id, speakerId, listenerId)) continue;
      markUsed(seed);
      counter += 1;
      seed.sequence = counter;
      return seed;
    }
    return null;
  }

  function status() {
    return {
      pairs: pairHistory.size,
      recent: globalHistory.length,
      cast: Object.keys(CAST).length,
    };
  }

  return {
    next,
    status,
    // exposed for the debug panel and tests
    opinionFor,
    bondsFor,
    relationshipFor,
  };
}
