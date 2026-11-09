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
import { opinionFor } from './cast.js';
import { createOfflineDialogue } from './offline_dialogue.js';
import { createDialogueCache } from './dialogue_cache.js';
import { createSocialContext } from './social_context.js';

// A chat is never padded to a length. Two villagers with nothing new to say part ways
// after a couple of turns; one with a real thread to pull can run to eight.
const MIN_TURNS = 2;
const MAX_TURNS = 8;

// What villagers actually talk about. Place talk is deliberately left out: the
// village and any city stay background, while conversations stay with people,
// memories, work and small personal things. One is drawn per conversation and
// offered to the model as a subject.
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
  'a recipe you have never managed to get right',
  'a lie you told that got out of hand',
  'a door that only seems to open at night',
  'the word home and what it means to you',
  'why cats stare at nothing',
  'the fastest you have ever run',
  'a letter you never sent',
  'whether people can really change',
  'the best thing you have ever eaten',
  'a journey you would take again if you could',
  'a recipe you have never managed to get right',
  'the last time you laughed until you cried',
  'a skill you wish you had learned',
  'something you changed your mind about',
  'what you do when you cannot sleep',
  'a promise you kept even when it was hard',
  'the best advice anyone ever gave you',
  'what you would say to someone who is gone',
  'a habit you cannot break',
  'a small risk that turned out to be worth it',
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
  // Optional override for tests. In the village this is created from the roster,
  // relationships and memories above.
  socialContext = null,
  // Lessons from the player: subjects a villager has been punished for, and habits
  // they have been praised for. Absent in tests that only exercise the dialogue.
  lessons = null,
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
    playerMessages: 0,
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
  const socialFocus = socialContext || createSocialContext({ roster, relationships, memories, rng });
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

  // A punished subject is removed from the pool for the villager who was corrected.
  // A praised subject is preferred when it is ready again. Both rules apply to every
  // participant, so a group chat does not hand someone the subject they just dropped.
  function topicPreferences(participantIds = []) {
    const banned = new Set();
    const praised = new Set();
    if (lessons) {
      for (const id of participantIds) {
        for (const topic of lessons.avoidTopics(id)) banned.add(topic.toLowerCase());
        for (const topic of lessons.goodHabits(id)) praised.add(topic.toLowerCase());
      }
    }
    return { banned, praised };
  }

  // Never the same subject twice in a row, so a pair that meets often still has
  // something new to bring up.
  function pickTopic(participantIds = []) {
    const { banned, praised } = topicPreferences(participantIds);
    const safe = TOPICS.filter((candidate) => !banned.has(candidate.toLowerCase()));
    const fresh = safe.filter((candidate) => !recentTopics.includes(candidate));
    const ready = fresh.filter((candidate) => dialogue.topicReady(candidate));
    const preferred = ready.filter((candidate) => praised.has(candidate.toLowerCase()));
    const pool = preferred.length ? preferred : ready.length ? ready : fresh.length ? fresh : safe;
    const topic = pool[Math.floor(rng() * pool.length)] || '';
    if (!topic) return '';
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

  // Gossip lands harder when it matches the listener's existing suspicion. The
  // relationship store applies the actual delta; this is only the direction and
  // strength the conversation carried.
  function socialTone(seed) {
    if (!seed) return 0;
    if (seed.angle === 'defend') return 0.7;
    if (seed.angle === 'secret') return 0.55;
    if (seed.angle === 'criticize' || seed.angle === 'grudge') return -0.9;
    if (seed.angle === 'rumor' || seed.angle === 'rumour') return seed.kind === 'fact' ? -0.35 : -0.65;
    if (seed.angle === 'envy') return -0.25;
    if (seed.angle === 'question') return -0.2;
    return 0.05;
  }

  function socialSeedEngaged(session, seed) {
    if (!seed || !seed.subjectName) return false;
    const name = String(seed.subjectName).toLowerCase();
    const claim = String(seed.claim || '').toLowerCase().slice(0, 24);
    return (session.messages || []).some((message) => {
      const text = String(message.text || '').toLowerCase();
      return text.includes(name) || (claim.length >= 8 && text.includes(claim));
    });
  }

  // Most conversations stay on one person. Some drift when someone brings up a
  // second name, which is exactly how real gossip changes direction halfway through.
  function maybePivot(session, speakerId, listenerId) {
    if (!socialFocus || !session.social || session.humanId || session.mood === 'tense') return;
    if (session.socialPivoted || turns(session) < 3 || modeForTurn(session) === 'closing') return;
    if (rng() > 0.34) return;
    const seed = socialFocus.next({
      speakerId,
      listenerId,
      participantIds: session.participants.map((participant) => participant.id),
    });
    if (!seed || seed.id === session.social.id) return;
    session.social = seed;
    session.socialSeeds.push(seed);
    session.topic = seed.title;
    session.socialPivoted = true;
  }

  function modeForTurn(session) {
    const turn = turns(session);
    if (turn === 0) return 'opening';
    if (turn >= session.target - 1) return 'closing';
    return 'reply';
  }

  // A social seed belongs to the person who raised it. When the other villager
  // answers, the subject stays on the table but the angle has to become their own:
  // they might agree, defend the absent person, ask a question or refuse to engage.
  // Without this, every reply was still written from the opener's point of view.
  function socialForTurn(seed, speakerId, listenerId) {
    if (!seed) return null;
    if (!speakerId || seed.speakerId === speakerId) return seed;
    const speaker = roster.find((candidate) => candidate && candidate.id === speakerId) || null;
    const listener = roster.find((candidate) => candidate && candidate.id === listenerId) || null;
    const originalSpeaker = nameFor(seed.speakerId);
    const subjectName = seed.subjectName || nameFor(seed.subjectId);
    const own = relationships && relationships.record
      ? relationships.record(speakerId, seed.subjectId)
      : null;
    const opinion = opinionFor(speakerId, seed.subjectId);
    const currentNote = opinion ? opinion.note : (own && own.notes) || '';
    const isSecretReply = seed.angle === 'secret';
    const angle = isSecretReply ? 'question' : 'reply';
    const category = isSecretReply ? 'question' : 'gossip';
    const instruction = isSecretReply
      ? `${originalSpeaker} has just told you something private about themselves. Respond like a person who was trusted: be careful with it, do not repeat the secret back as gossip, and do not turn it into a speech. Ask one small question or say something plain.`
      : `${originalSpeaker} just brought up ${subjectName}. The subject is already on the table. Respond from your own view of ${subjectName}; agree, push back, ask what they mean, or change the subject if you have had enough. Do not repeat their claim as if it were yours.`;
    return {
      ...seed,
      speakerId,
      listenerId,
      angle,
      category,
      sourceId: null,
      sourceName: '',
      kind: 'opinion',
      claim: isSecretReply ? seed.claim : (currentNote || seed.claim),
      confidence: 0.5,
      instruction,
      speakerStance: own ? own.category : 'stranger',
      listenerStance: relationshipForTurn(seed.speakerId, seed.subjectId),
      orientation: 'reply',
      raisedBy: originalSpeaker,
      listenerName: listener ? listener.name : nameFor(listenerId),
      speakerName: speaker ? speaker.name : nameFor(speakerId),
    };
  }

  function relationshipForTurn(speakerId, subjectId) {
    try {
      return relationships && relationships.record ? relationships.record(speakerId, subjectId).category : 'stranger';
    } catch {
      return 'stranger';
    }
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

  function begin(npcA, npcB, { ignoreCooldown = false } = {}) {
    if (!ignoreCooldown && !canTalk(npcA, npcB)) return null;
    const a = entryFor(npcA);
    const b = entryFor(npcB);
    if (!a || !b) return null;

    counter += 1;
    const target = MIN_TURNS + Math.floor(rng() * (MAX_TURNS - MIN_TURNS + 1));
    // Every chat starts with a person, not an abstract subject. The fallback topic is
    // only used when there is nobody else in the village to talk about.
    const socialSeed = socialFocus.next({
      speakerId: a.id,
      listenerId: b.id,
      participantIds: [a.id, b.id],
    });
    const topic = socialSeed ? socialSeed.title : pickTopic([a.id, b.id]);
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
      // The live NPC objects, in the same order as participants. A third villager can
      // be appended here when they join, up to three speakers.
      npcs: [npcA, npcB],
      initiatorId: a.id,
      responderId: b.id,
      startedAt: new Date().toISOString(),
      endedAt: null,
      target,
      topic,
      mood,
      social: socialSeed,
      socialSeeds: socialSeed ? [socialSeed] : [],
      socialPivoted: false,
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
      // What this villager has been taught during this particular chat. This is
      // separate from the persisted lesson book: it makes the current conversation
      // react immediately to a punishment or a reward.
      lessonNotes: new Map(),
      // A real person can be one of the participants. The manager waits for their
      // line instead of asking the model to speak for them.
      humanId: null,
      awaitingHuman: false,
      playerStarted: false,
    };

    sessions.set(session.id, session);
    stats.started += 1;
    return session;
  }

  // One turn is one request to the model. A line that had to be split into a follow-up
  // message stays part of the same turn, so the villagers keep alternating speakers.
  const turns = (session) => session.messages.filter((message) => !message.extra).length;

  const npcsOf = (session) => session.npcs || [session.npcA, session.npcB];

  function npcForId(session, id) {
    return npcsOf(session).find((npc) => npc && npc.config && npc.config.id === id) || null;
  }

  // The last person who actually spoke, ignoring the current speaker. Extra
  // follow-up bubbles belong to the same speaker, so they do not change the turn.
  function lastSpokenId(session, excludeId = null) {
    for (let i = session.messages.length - 1; i >= 0; i -= 1) {
      const id = session.messages[i] && session.messages[i].speakerId;
      if (!id || id === excludeId) continue;
      return id;
    }
    return null;
  }

  // The next speaker follows the person who actually spoke last, not the total
  // message count. Counting modulo the participant list breaks when a third person
  // joins: it can hand the turn straight back to the player or skip a villager.
  // The old count is only a fallback for an empty transcript.
  function speakerAt(session, turn = turns(session)) {
    const lastId = lastSpokenId(session);
    if (lastId) {
      const at = session.participants.findIndex((participant) => participant.id === lastId);
      if (at >= 0) return session.participants[(at + 1) % session.participants.length] || null;
    }
    return session.participants[turn % session.participants.length] || null;
  }

  // The listener is the person who just spoke and is being answered, not merely the
  // next person in the circle. In a three-person chat the next participant can be a
  // bystander; using them makes the prompt address the reply to the wrong name.
  function listenerAfter(session, speakerId) {
    const lastId = lastSpokenId(session, speakerId);
    if (lastId) {
      const last = session.participants.find((participant) => participant.id === lastId);
      if (last) return last;
    }
    const at = session.participants.findIndex((participant) => participant.id === speakerId);
    if (at < 0) return null;
    return session.participants[(at + 1) % session.participants.length] || null;
  }

  // A nearby villager joins the chat. Three is the limit: a fourth voice turns a
  // conversation into a crowd and nobody can follow the transcript.
  function join(session, npc, { ignoreCooldown = false } = {}) {
    if (!session || session.status !== 'active' || !npc || !npc.config) return false;
    if (session.participants.length >= 3) return false;
    const id = npc.config.id;
    if (session.participants.some((participant) => participant.id === id)) return false;
    const entry = entryFor(npc);
    if (!entry) return false;
    for (const participant of session.participants) {
      const other = npcForId(session, participant.id);
      if (!other) return false;
      if (!ignoreCooldown && !canTalk(npc, other)) return false;
    }
    session.participants.push({ id: entry.id, name: entry.name });
    if (!session.npcs) session.npcs = npcsOf(session);
    session.npcs.push(npc);
    session.joined = (session.joined || 0) + 1;
    // A newcomer needs a turn or two to say anything worth hearing.
    session.target = Math.min(12, session.target + 2);
    session.joinedAt = session.clock;
    return true;
  }

  // A player-started chat begins with the human's line. The NPC still gets the same
  // profile, relationship, memory and environment context as an ordinary villager,
  // so a player conversation is not a separate, dumber dialogue path.
  function beginPlayer(playerNpc, npcB) {
    if (!playerNpc || !npcB || playerNpc === npcB) return null;
    const session = begin(playerNpc, npcB, { ignoreCooldown: true });
    if (!session) return null;
    session.humanId = playerNpc.config.id;
    session.awaitingHuman = true;
    session.playerStarted = true;
    session.target = Math.max(session.target, 12);
    return session;
  }

  // Joining an existing two-person chat adds the player as the third speaker. The
  // pair pauses on the player's turn and resumes as soon as a line is submitted.
  function joinPlayer(sessionId, playerNpc) {
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'active' || !playerNpc || !playerNpc.config) return null;
    if (session.humanId) return session.humanId === playerNpc.config.id ? session : null;
    // Adding a voice while a line is already being written makes the pending reply
    // answer the old pair, not the player. Let that line land first.
    if (session.pending) return null;
    if (!join(session, playerNpc, { ignoreCooldown: true })) return null;
    session.humanId = playerNpc.config.id;

    // Put the player immediately after the person who was speaking so the circle
    // genuinely hands them the next turn. Appending them at the end only works when
    // the last speaker happened to be the final participant already.
    const lastId = lastSpokenId(session);
    if (lastId) {
      const at = session.participants.findIndex((participant) => participant.id === lastId);
      if (at >= 0 && at < session.participants.length - 1) {
        const playerPart = session.participants.pop();
        const playerBody = session.npcs.pop();
        session.participants.splice(at + 1, 0, playerPart);
        session.npcs.splice(at + 1, 0, playerBody);
      }
    }

    session.awaitingHuman = true;
    session.target = Math.max(session.target, turns(session) + 4);
    return session;
  }

  function playerSay(sessionId, text) {
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'active') {
      return { ok: false, reason: 'That conversation has ended.' };
    }
    if (!session.humanId) return { ok: false, reason: 'This is not a player conversation.' };
    if (session.pending) return { ok: false, reason: 'Wait for the reply first.' };
    if (!session.awaitingHuman) return { ok: false, reason: 'It is not your turn yet.' };
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 180);
    if (!clean) return { ok: false, reason: 'Type a line first.' };

    addMessage(session, session.humanId, clean, 'player', false);
    session.awaitingHuman = false;
    session.target = Math.max(session.target, turns(session) + 4);
    // Ask for the answer immediately; update() will not have to wait for its next
    // clock tick before the villager starts writing.
    requestLine(session);
    return { ok: true, session: snapshotSession(session) };
  }

  function leavePlayer(sessionId, reason = 'player_left') {
    const session = sessions.get(sessionId);
    if (!session) return false;
    abandon(session, reason);
    return true;
  }

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
    if (generatedBy === 'player') stats.playerMessages += 1;
    else if (generatedBy === 'groq') stats.groqMessages += 1;
    else if (generatedBy === 'cached') stats.cachedMessages += 1;
    else stats.offlineMessages += 1;

    const npc = npcForId(session, speakerId);
    if (npc && npc.sim) npc.sim.dialogue = text;
    return message;
  }

  function payloadFor(session, mode, speakerId) {
    const speakerEntry = entryFor(npcForId(session, speakerId));
    const listener = listenerAfter(session, speakerId);
    const listenerEntry = listener ? entryFor(npcForId(session, listener.id)) : null;
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
    const avoidTopics = lessons ? lessons.avoidTopics(speakerEntry.id) : [];
    const goodHabits = lessons ? lessons.goodHabits(speakerEntry.id) : [];
    const lesson = session.lessonNotes ? session.lessonNotes.get(speakerEntry.id) : null;

    return {
      conversationId: session.id,
      mode,
      topic: session.topic || '',
      mood: session.mood || 'calm',
      messageCount: turns(session),
      speaker: { ...speakerCtx, avoidTopics, goodHabits },
      lessonNote: lesson ? lesson.note : '',
      listener: contextFor(listenerEntry),
      history: session.messages.map((message) => ({
        speakerId: message.speakerId,
        speakerName: message.speakerName,
        text: message.text,
      })),
      memories: memoryList,
      relationship: relationships ? relationships.record(speakerEntry.id, listenerEntry.id) : null,
      relationshipChange: session.changeNote || null,
      social: socialForTurn(session.social, speakerId, listenerEntry.id),
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
    const speakerNow = speakerAt(session, turn);
    const speakerId = speakerNow ? speakerNow.id : session.participants[0].id;
    const listenerNow = listenerAfter(session, speakerId);
    if (listenerNow) maybePivot(session, speakerId, listenerNow.id);
    // The player writes their own lines. Never send a request that would put words
    // in their mouth; the UI will hand the turn back when a line is submitted.
    if (session.humanId && speakerId === session.humanId) {
      session.pending = false;
      session.awaitingHuman = true;
      return;
    }
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

    const speakerEntry = entryFor(npcForId(session, speakerId));
    const listener = listenerAfter(session, speakerId);
    const listenerEntry = listener ? entryFor(npcForId(session, listener.id)) : null;
    const profile = profileFor(speakerEntry || {});
    const otherProfile = profileFor(listenerEntry || {});
    const turnSocial = socialForTurn(session.social, speakerId, listenerEntry ? listenerEntry.id : null);
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
        // A social line is tied to particular people and a particular claim, so it is
        // never safe to reuse in another conversation.
        if (!session.social) {
          dialogueCache.remember({
            text: parts[0],
            mode,
            mood: session.mood,
            topic: session.topic,
            weatherKey: env.weather ? env.weather.key : '',
            timeOfDay: env.timeOfDay,
            category: mode,
          });
        }
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

    // 2. A line the model produced before for a comparable moment. Social lines are
    // never taken from the cache: a line about one person cannot be dropped into a
    // conversation about another.
    if (!parts.length && session.mood !== 'tense' && !session.social) {
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
        social: turnSocial,
        activity: activityOf(npcForId(session, speakerId)),
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

  // The player has just punished or rewarded the subject of this villager's active
  // conversation. Record the lesson, and make the current chat feel it immediately:
  // a punishment swaps the subject, while a reward keeps the subject and adds praise.
  function react(npc, kind = 'punish') {
    if (!lessons || !npc || !npc.config) return null;
    const npcId = npc.config.id;
    const session = [...sessions.values()].find((candidate) => (
      candidate.status === 'active' && candidate.participants.some((participant) => participant.id === npcId)
    ));
    if (!session || !session.topic) return null;

    const action = kind === 'reward' ? 'good' : 'avoid';
    const learned = lessons.record(npcId, action, session.topic);
    if (!learned) return null;

    const note = action === 'avoid'
      ? `You were just corrected for bringing up ${learned.topic}. Drop that subject and do not return to it.`
      : `You were just praised for talking about ${learned.topic}. That is a good habit; keep it up when it fits.`;
    session.lessonNotes.set(npcId, { kind: action, topic: learned.topic, note });

    let replacement = null;
    if (action === 'avoid') {
      // The old subject is now banned for this villager, so this cannot pick it again.
      replacement = pickTopic(session.participants.map((participant) => participant.id));
      if (replacement) session.topic = replacement;
    }

    return { kind: action, topic: learned.topic, note, sessionId: session.id, replacement };
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
    for (const npc of npcsOf(session)) {
      if (npc && npc.sim && npc.sim.session === session) npc.sim.session = null;
    }

    // Every pair that shared the chat waits out a cooldown, not just the first two.
    const cooldown = cooldownFor(session);
    const people = session.participants;
    for (let i = 0; i < people.length; i += 1) {
      for (let j = i + 1; j < people.length; j += 1) {
        pairCooldowns.set(pairKey(people[i].id, people[j].id), Date.now() + cooldown * 1000);
      }
    }

    if (outcome === 'complete') stats.completed += 1;
    else if (outcome === 'failed') stats.failed += 1;
    else stats.abandoned += 1;

    // What the conversation left behind. A chat that never got past one line, or one
    // that failed outright, does not move a relationship.
    const realExchange = turns(session) >= 2 && (outcome === 'complete' || outcome === 'abandoned');
    if (realExchange && relationships) {
      // Score each pair separately: the third villager was not part of every line and
      // should not inherit the relationship change of a conversation they only half heard.
      const changes = [];
      const memoriesMade = [];
      let toneSum = 0;
      let toneCount = 0;
      for (let i = 0; i < people.length; i += 1) {
        for (let j = i + 1; j < people.length; j += 1) {
          const p1 = people[i];
          const p2 = people[j];
          const messages = session.messages.filter((message) => message.speakerId === p1.id || message.speakerId === p2.id);
          if (messages.length < 2) continue;
          const pairSession = { ...session, participants: [p1, p2], messages };
          const profileA = profileFor(entryFor(npcForId(session, p1.id)) || {});
          const profileB = profileFor(entryFor(npcForId(session, p2.id)) || {});
          const disagreement = session.mood === 'tense'
            || messages.some((message) => ANGER.test(message.text));
          const result = relationships.applyConversation(pairSession, {
            profileA,
            profileB,
            disagreement,
            newsUsed: session.news.length > 0 && messages.some((message) => /news|headline|heard/i.test(message.text)),
          });
          if (result) {
            changes.push(...(result.changes || []));
            if (Number.isFinite(Number(result.tone))) {
              toneSum += Number(result.tone);
              toneCount += 1;
            }
          }
          const pairSeeds = (session.socialSeeds || []).filter((seed) => seed
            && [p1.id, p2.id].includes(seed.speakerId)
            && [p1.id, p2.id].includes(seed.listenerId));
          if (memories) {
            const created = memories.consider(pairSession, {
              profileA,
              profileB,
              relationshipChanges: result ? result.changes : [],
              news: session.news[0] || null,
              disagreement,
              socialSeeds: pairSeeds,
            }) || [];
            for (const memory of created) {
              if (!memoriesMade.some((existing) => existing.id === memory.id)) memoriesMade.push(memory);
            }
          }
        }
      }

      // A rumour changes the listener's view of the person being discussed, not the
      // view of the person who told it. This is the part that makes gossip have a
      // consequence after the conversation is over.
      if (relationships.applySocialClaim) {
        for (const seed of session.socialSeeds || []) {
          if (!seed || !seed.listenerId || !seed.subjectId) continue;
          if (!people.some((person) => person.id === seed.listenerId)) continue;
          if (!people.some((person) => person.id === seed.speakerId)) continue;
          if (!socialSeedEngaged(session, seed)) continue;
          const change = relationships.applySocialClaim({
            listenerId: seed.listenerId,
            subjectId: seed.subjectId,
            sourceId: seed.sourceNpcId || seed.speakerId,
            kind: seed.kind || 'claim',
            tone: socialTone(seed),
            confidence: seed.confidence || 0.5,
          });
          if (change) changes.push(change);
        }
      }

      session.relationshipChanges = changes;
      session.tone = toneCount ? toneSum / toneCount : 0;
      session.memories = memoriesMade;
    }

    const dialogueClear = npcsOf(session);
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
      for (const npc of npcsOf(session)) onHandBack(npc);
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

      const group = npcsOf(session);
      const anchor = group[0];
      if (group.length < 2 || group.some((npc) => !npc || !npc.sim)) {
        finish(session, 'abandoned', 'missing_villager');
        continue;
      }
      // someone walked away, went to bed, or the editor froze the village. A group
      // member only has to be facing the circle, not paired with one specific person.
      const ids = new Set(session.participants.map((participant) => participant.id));
      const stillTalking = group.every((npc) => npc.sim.state === 'talking'
        && npc.sim.partner && npc.sim.partner.config
        && ids.has(npc.sim.partner.config.id));
      if (!stillTalking) {
        finish(session, 'abandoned', 'participant_left');
        continue;
      }

      const limit = group.length > 2 ? 34 : 20;
      const gap = Math.max(...group.map((npc) => Math.hypot(npc.x - anchor.x, npc.y - anchor.y)));
      if (gap > limit) {
        session.wait += step;
        if (session.wait > APPROACH_LIMIT) finish(session, 'abandoned', 'unreachable');
        continue;
      }
      if (session.wait > 0) session.wait = 0;

      const sessionLimit = session.humanId ? 600 : SESSION_LIMIT;
      if (session.clock > sessionLimit) {
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

      // A player chat waits for a submitted line. This check comes before the
      // automatic turn so an empty opening never turns into an AI-written player
      // message.
      if (session.humanId) {
        const next = speakerAt(session, turns(session));
        if (turns(session) === 0 || (next && next.id === session.humanId)) {
          session.awaitingHuman = true;
          continue;
        }
        // The waiting flag can be left over from a join that happened while a reply
        // was in flight. Once the circle has moved on to a villager, do not wait for
        // a human turn that is not theirs.
        session.awaitingHuman = false;
      }
      if (session.awaitingHuman) continue;

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
      social: session.social ? { ...session.social } : null,
      socialSeeds: (session.socialSeeds || []).map((seed) => ({ ...seed })),
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
      humanId: session.humanId || null,
      awaitingHuman: !!session.awaitingHuman,
      playerStarted: !!session.playerStarted,
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
    beginPlayer,
    join,
    joinPlayer,
    playerSay,
    leavePlayer,
    react,
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
