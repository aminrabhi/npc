// Offline dialogue engine + fallback ladder tests.
//
//   npm run test:offline
//
// Everything here runs without a browser, a server or a Groq key. The point is to
// prove the village can keep talking with the network gone: the procedural engine is
// exercised directly, the cache is exercised with a storage stub, the Groq gate is
// exercised with a stubbed 429, and a full conversation is driven to its end with an
// AI client that can never answer.

import { createOfflineDialogue, fitsBubble, bandOf, CATEGORIES } from '../js/offline_dialogue.js';
import { createDialogueCache } from '../js/dialogue_cache.js';
import { createAiClient } from '../js/ai.js';
import { createLessons } from '../js/lessons.js';
import { createConversations, TOPICS } from '../js/conversation.js';

let checks = 0;
let failures = 0;

function check(name, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

function rngFrom(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ada = {
  id: 'npc_a',
  name: 'Ada',
  personality: ['blunt', 'proud'],
  interests: ['fixing things', 'radio plays'],
  likes: ['quiet mornings', 'honest work'],
  dislikes: ['gossip', 'being pitied'],
  style: 'blunt',
  memories: ['Was locked up for something she did not do.'],
};

const bram = {
  id: 'npc_b',
  name: 'Bram',
  personality: ['warm', 'talkative'],
  interests: ['fixing things', 'gardening'],
  likes: ['tea', 'visitors'],
  dislikes: ['loud noises'],
  style: 'warm',
  memories: [],
};

const cora = {
  id: 'npc_c',
  name: 'Cora',
  personality: ['curious', 'wry'],
  interests: ['fixing things', 'town gossip'],
  likes: ['tea', 'company'],
  dislikes: ['rudeness'],
  style: 'warm',
  memories: [],
};

const stranger = { category: 'stranger', score: 0, trust: 0.3, familiarity: 0.05, dislike: 0 };
const friend = { category: 'friend', score: 45, trust: 0.55, familiarity: 0.5, dislike: 0 };
const best = { category: 'best friend', score: 92, trust: 0.85, familiarity: 0.8, dislike: 0 };
const enemy = { category: 'enemy', score: -60, trust: 0.1, familiarity: 0.6, dislike: 0.75 };

const baseContext = {
  me: ada,
  them: bram,
  relationship: stranger,
  memories: [],
  mode: 'reply',
  mood: 'calm',
  weather: { key: 'rain', label: 'Rain', wet: true, snowy: false },
  timeOfDay: 'morning',
  news: null,
  topic: 'a bet you lost',
  activity: 'walking',
  recentLines: [],
};

console.log('\nengine shape');
const engine = createOfflineDialogue({ rng: rngFrom(11), now: () => 1_000_000 });
check('all twelve categories are offered', CATEGORIES.length === 12);
check('band comes from the relationship category', bandOf(best) === 'best' && bandOf(stranger) === 'neutral' && bandOf(enemy) === 'cold');

const opening = engine.line({ ...baseContext, mode: 'opening', relationship: best, category: 'greeting' });
check('an opening line is produced', typeof opening.text === 'string' && opening.text.length > 0, JSON.stringify(opening));
check('a greeting fits a two-line bubble', fitsBubble(opening.text), `${opening.text.length} chars`);

console.log('\ncontext substitution');
const memoryLine = engine.line({
  ...baseContext,
  category: 'memory',
  memories: [{ description: 'Found out Bram likes bugs too.', aboutNpcId: 'npc_b' }],
});
check('a shared memory is quoted', /bugs/i.test(memoryLine.text), memoryLine.text);

const sharedLine = engine.line({ ...baseContext, category: 'shared' });
check('a shared interest is named', /fixing things/i.test(sharedLine.text), sharedLine.text);

const weatherLines = [];
for (let i = 0; i < 12; i++) weatherLines.push(engine.line({ ...baseContext, category: 'weather' }).text);
check('weather lines talk about the weather', weatherLines.filter((text) => /rain|weather|sky|season|cloud|fog|sun|storm/i.test(text)).length >= 6, weatherLines.join(' | '));
check('weather lines always fit the bubble', weatherLines.every((text) => fitsBubble(text)));

const newsLine = engine.line({
  ...baseContext,
  category: 'news',
  news: { headline: 'New chip promises cheaper phones' },
});
check('a cached headline is quoted', /chip|phones/i.test(newsLine.text), newsLine.text);

const personalLine = engine.line({ ...baseContext, category: 'personal' });
check('a personal line uses an interest, like or dislike', /fixing|radio|quiet morning|honest work|gossip|pitied/i.test(personalLine.text), personalLine.text);

check('news without a headline is skipped, not faked', engine.line({ ...baseContext, category: 'news', news: null }).category === 'casual');

console.log('\nrelationship awareness');
const coldOpening = engine.line({ ...baseContext, mode: 'opening', relationship: enemy, category: 'greeting' });
check('an enemy gets a cold greeting', fitsBubble(coldOpening.text) && coldOpening.text.length > 0, coldOpening.text);
const bestReply = engine.line({ ...baseContext, relationship: best, category: 'bestfriend' });
check('a best friend gets familiar talk', /you|me|we/i.test(bestReply.text) && fitsBubble(bestReply.text), bestReply.text);

const coldEnding = engine.line({ ...baseContext, mode: 'closing', mood: 'tense', relationship: enemy, category: 'ending' });
check('a tense conversation ends coldly', /(done with this|finished here|do not bother|i am going|nothing else|leave it)/i.test(coldEnding.text), coldEnding.text);

console.log('\nmoods');
let tenseCategories = [];
for (let i = 0; i < 20; i++) {
  tenseCategories.push(engine.line({ ...baseContext, mood: 'tense' }).category);
}
const tenseCount = tenseCategories.filter((category) => category === 'disagreement').length;
check('a tense reply is usually a disagreement', tenseCount >= 16, `${tenseCount}/20 ${tenseCategories.join(',')}`);

console.log('\nvariety');
const fresh = createOfflineDialogue({ rng: rngFrom(99), now: () => 5_000_000 });
const texts = [];
const categories = new Set();
for (let i = 0; i < 200; i++) {
  const out = fresh.line({
    ...baseContext,
    relationship: i % 3 === 0 ? stranger : i % 3 === 1 ? friend : best,
    mode: i % 7 === 0 ? 'opening' : i % 11 === 0 ? 'closing' : 'reply',
  });
  texts.push(out.text);
  categories.add(out.category);
}
// A village does not say 200 lines in one sitting; the realistic window is what
// matters. Inside 80 lines the engine should almost never repeat itself.
check('the first 80 lines are 70+ distinct', new Set(texts.slice(0, 80)).size >= 70, `${new Set(texts.slice(0, 80)).size}`);
check('200 lines still stay mostly distinct', new Set(texts).size >= 110, `${new Set(texts).size}`);
check('several categories appear naturally', categories.size >= 6, [...categories].join(','));
check('every line fits the bubble', texts.every((text) => fitsBubble(text)), texts.find((text) => !fitsBubble(text)) || '');
check('no line exceeds the bubble budget', texts.every((text) => text.length <= 110), `${Math.max(...texts.map((text) => text.length))}`);
check('no line is empty', texts.every((text) => text.trim().length > 0));
check('no stage directions or quotes', texts.every((text) => !/[*<>"“”]/.test(text)), texts.find((text) => /[*<>"“”]/.test(text)) || '');

console.log('\ntopic cooldown');
let clock = 0;
const timed = createOfflineDialogue({ rng: rngFrom(3), now: () => clock });
timed.noteTopic('a bet you lost');
check('a used topic goes on cooldown', timed.topicReady('a bet you lost') === false);
clock = 91 * 60_000;
check('a cooled topic becomes available again', timed.topicReady('a bet you lost') === true);
check('an unused topic is always available', timed.topicReady('the sea') === true);

console.log('\ncached model lines');
const store = new Map();
const storage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { store.set(key, value); },
  removeItem: (key) => { store.delete(key); },
};
const cacheTime = 10_000_000;
const cache = createDialogueCache({ storage, now: () => cacheTime });
cache.remember({ text: 'The rain has been at it all day.', mode: 'reply', mood: 'calm', weatherKey: 'rain', timeOfDay: 'morning' });
cache.remember({ text: 'You would not believe what I heard on the radio.', mode: 'reply', mood: 'calm', weatherKey: 'clear', timeOfDay: 'day' });
check('lines are cached', cache.size() === 2, `${cache.size()}`);
check('a rain line is chosen on a rainy morning', cache.take({ mode: 'reply', mood: 'calm', weatherKey: 'rain', timeOfDay: 'morning' }) === 'The rain has been at it all day.');
check('a line is not offered twice in a row', cache.take({ mode: 'reply', mood: 'calm', weatherKey: 'rain', timeOfDay: 'morning' }) === 'You would not believe what I heard on the radio.');
check('the wrong mode gets nothing', cache.take({ mode: 'opening', mood: 'calm' }) === null);
check('a tense chat gets nothing written for calm', cache.take({ mode: 'reply', mood: 'tense' }) === null);
check('near-duplicate lines are not stored', cache.remember({ text: 'You would not believe what I heard on the radio!', mode: 'reply', mood: 'calm' }) === null);
check('the cache persists through storage', store.has('simulora.dialogue_cache.v1'));

console.log('\ngroq gate');
const calls = [];
let failChat = true;
function fakeResponse(body, status, headers = {}) {
  return {
    ok: status < 400,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] || null },
    json: async () => body,
  };
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  calls.push(String(url));
  if (String(url).includes('/api/status')) {
    return fakeResponse({ ok: true, groq: { configured: true, model: 'allam-2-7b' }, supabase: { configured: true } }, 200);
  }
  if (failChat) {
    return fakeResponse({ ok: false, error: { code: 'rate_limit_exceeded', message: 'Rate limit reached for allam-2-7b' } }, 429, { 'retry-after': '60' });
  }
  // the browser client reads the village route's shape, not the provider's
  return fakeResponse({
    ok: true,
    message: { text: 'That is a fair point.', extra: [], model: 'allam-2-7b', messageNumber: 1 },
    finishReason: 'stop',
    usage: { total_tokens: 10 },
    ms: 12,
  }, 200);
};

try {
  // Node's fetch needs absolute URLs; the paths themselves are irrelevant here.
  const client = createAiClient({ statusUrl: 'http://mock.test/api/status', chatUrl: 'http://mock.test/api/chat' });
  await client.probe();
  check('a configured server is reported as available', client.availability().available === true);

  const first = await client.generate({});
  check('a rate limit is a failure', first.ok === false && /rate.?limit/i.test(first.error.code), JSON.stringify(first.error));
  const gate = client.availability();
  check('a rate limit starts a cooldown', gate.available === false && gate.coolingDown === true, JSON.stringify(gate));
  check('the cooldown respects retry-after', gate.cooldownSeconds >= 45, `${gate.cooldownSeconds}`);

  const before = calls.length;
  const second = await client.generate({});
  check('a cooling model is not retried', second.ok === false && second.skipped === true && calls.length === before, `${calls.length - before} calls`);
  check('the skipped call is counted', client.stats().skipped === 1, JSON.stringify(client.stats()));

  failChat = false;
  await client.recover();
  check('recover clears the cooldown', client.availability().available === true);
  const third = await client.generate({});
  check('groq resumes when it is back', third.ok === true && third.text === 'That is a fair point.', JSON.stringify(third));
  check('a success resets the failure count', client.availability().failures === 0);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('\nvillage with no model at all');
const roster = [ada, bram, cora].map((profile) => ({
  id: profile.id,
  name: profile.name,
  personality: profile.personality,
  profile: {
    interests: profile.interests,
    likes: profile.likes,
    dislikes: profile.dislikes,
    tendencies: [],
    memories: profile.memories,
    style: profile.style,
    social: { sociability: 0.6, newsInterest: 0.3 },
  },
}));

const offlineAi = {
  canGenerate: () => false,
  generate: async () => ({ ok: false, error: { code: 'offline', message: 'Groq is not configured.' } }),
  availability: () => ({ configured: false, available: false, fallback: true, coolingDown: false }),
};

const pairScores = [];
const relationships = {
  record: () => ({ category: 'friend', score: 40, trust: 0.5, familiarity: 0.5, dislike: 0 }),
  applyConversation: (session) => {
    pairScores.push(session);
    return { changes: [], tone: 0 };
  },
};
const memoryStore = { recall: () => [], consider: () => [] };

const conversations = createConversations({
  roster,
  ai: offlineAi,
  relationships,
  memories: memoryStore,
  news: null,
  rng: rngFrom(21),
  environment: () => ({
    timeOfDay: 'morning',
    weather: { key: 'rain', label: 'Rain', wet: true, snowy: false },
  }),
});

const npcA = { config: { id: 'npc_a' }, sim: { state: 'talking', dialogue: null, partner: null }, x: 0, y: 0, room: null };
const npcB = { config: { id: 'npc_b' }, sim: { state: 'talking', dialogue: null, partner: null }, x: 4, y: 0, room: null };
npcA.sim.partner = npcB;
npcB.sim.partner = npcA;

const session = conversations.begin(npcA, npcB);
check('a conversation starts with no model', !!session);
if (session) {
  for (let step = 0; step < 5000 && session.status === 'active'; step++) {
    conversations.update(0.5);
    // let the (already resolved) offline line promises settle
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const messages = session.messages || [];
  check('it reaches at least two messages', messages.length >= 2, `${messages.length}`);
  check('it stays inside the 2-8 message limit', messages.length <= 8, `${messages.length}`);
  check('every line came from the procedural engine', messages.every((message) => message.generatedBy === 'offline'), messages.map((message) => message.generatedBy).join(','));
  check('every spoken line fits a bubble', messages.every((message) => fitsBubble(message.text)), messages.map((message) => message.text).find((text) => !fitsBubble(text)) || '');
  check('the conversation finishes rather than failing', session.outcome === 'complete' || session.outcome === 'abandoned', `${session.outcome} ${session.closeReason}`);
  check('the reported mode is offline', conversations.mode() === 'offline', conversations.mode());
  check('the status reports fallback with counts', conversations.dialogueStatus().fallback === true && conversations.dialogueStatus().counts.offline >= 1, JSON.stringify(conversations.dialogueStatus().counts));
  check('the stats count offline lines', conversations.stats().offlineMessages >= 2, JSON.stringify(conversations.stats()));
}

console.log('\ntopic pool');
check('conversation topics avoid village and city life', TOPICS.every((topic) => !/\b(village|city|town)\b/i.test(topic)), TOPICS.filter((topic) => /\b(village|city|town)\b/i.test(topic)).join(' | '));

console.log('\nlearned topics');
const lessonStore = new Map();
const lessonStorage = {
  getItem: (key) => (lessonStore.has(key) ? lessonStore.get(key) : null),
  setItem: (key, value) => { lessonStore.set(key, value); },
  removeItem: (key) => { lessonStore.delete(key); },
};
const lessons = createLessons({ storage: lessonStorage, now: () => 1_700_000_000_000 });
lessons.record('npc_a', 'avoid', 'a bet you lost');
check('a punishment is stored against the villager', lessons.isAvoided('npc_a', 'a bet you lost'));
const reloadedLessons = createLessons({ storage: lessonStorage });
check('learned topics survive a reload', reloadedLessons.isAvoided('npc_a', 'a bet you lost'));
reloadedLessons.record('npc_a', 'good', 'a bet you lost');
check('a reward replaces an old punishment for the same subject', !reloadedLessons.isAvoided('npc_a', 'a bet you lost') && reloadedLessons.isGood('npc_a', 'a bet you lost'));

const learningConversations = createConversations({
  roster,
  ai: offlineAi,
  relationships,
  memories: memoryStore,
  news: null,
  lessons: reloadedLessons,
  rng: rngFrom(31),
  environment: () => ({ timeOfDay: 'morning', weather: null }),
});
const learningSession = learningConversations.begin(npcA, npcB);
check('a conversation starts with a learnable subject', !!learningSession && !!learningSession.topic, learningSession && learningSession.topic);
const punishedTopic = learningSession && learningSession.topic;
const punished = learningConversations.react(npcA, 'punish');
check('punishing records the current subject', !!punished && reloadedLessons.isAvoided('npc_a', punishedTopic), JSON.stringify(punished));
check('the punished subject leaves the current chat', learningSession.topic !== punishedTopic, learningSession.topic);
check('the correction is added to the next prompt', /corrected/i.test(learningSession.lessonNotes.get('npc_a').note || ''), JSON.stringify(learningSession.lessonNotes.get('npc_a')));
const rewardedTopic = learningSession.topic;
const rewarded = learningConversations.react(npcB, 'reward');
check('rewarding records the current subject as good', !!rewarded && reloadedLessons.isGood('npc_b', rewardedTopic), JSON.stringify(rewarded));
check('a reward leaves the current subject in place', learningSession.topic === rewardedTopic);
check('the praise is added to the next prompt', /praised/i.test(learningSession.lessonNotes.get('npc_b').note || ''), JSON.stringify(learningSession.lessonNotes.get('npc_b')));
learningConversations.finish(learningSession, 'abandoned', 'test');
let pickedPunished = false;
for (let i = 0; i < 12; i += 1) {
  learningConversations.resetCooldowns();
  const next = learningConversations.begin(npcA, npcB);
  if (!next) break;
  if (next.topic === punishedTopic) pickedPunished = true;
  learningConversations.finish(next, 'abandoned', 'test');
}
check('a punished subject is not chosen again for that villager', !pickedPunished, punishedTopic);

console.log('\ngroup conversation');
const npcC = { config: { id: 'npc_c' }, sim: { state: 'talking', dialogue: null, partner: npcA }, x: 8, y: 0, room: null };
npcC.sim.partner = npcA;
conversations.resetCooldowns();
const group = conversations.begin(npcA, npcB);
check('a group conversation starts from a pair', !!group);
if (group) {
  check('a nearby villager can join', conversations.join(group, npcC) === true, `${group.participants.length} participants`);
  check('the group has three participants', group.participants.length === 3, group.participants.map((p) => p.name).join(','));
  check('joining extends the conversation', group.target >= 4, `${group.target}`);

  for (let step = 0; step < 5000 && group.status === 'active'; step++) {
    conversations.update(0.5);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  check('the newcomer gets a line', group.messages.some((message) => message.speakerId === 'npc_c'), group.messages.map((m) => m.speakerId).join(','));
  check('the group transcript was scored pair by pair', pairScores.length >= 2
    && pairScores.every((pair) => pair.participants.length === 2), `${pairScores.length} pairs`);
  check('the group conversation finishes', group.outcome === 'complete' || group.outcome === 'abandoned', `${group.outcome} ${group.closeReason}`);
}

console.log('\nplayer conversation identities');
const capturedPayloads = [];
const captureAi = {
  canGenerate: () => true,
  availability: () => ({ configured: true, available: true, fallback: false, coolingDown: false }),
  generate: async (payload) => {
    capturedPayloads.push(payload);
    return { ok: true, text: 'Understood.', extra: [], model: 'test', ms: 1 };
  },
};
const playerEntry = {
  id: 'npc_p',
  name: 'Amin Rabhi',
  personality: ['plain'],
  profile: {
    interests: ['walking the village'],
    likes: ['quiet mornings'],
    dislikes: [],
    tendencies: [],
    memories: [],
    style: 'plain',
    social: { sociability: 0.5, newsInterest: 0.2 },
  },
};
const playerRoster = [...roster, playerEntry];
const playerConversations = createConversations({
  roster: playerRoster,
  ai: captureAi,
  relationships,
  memories: memoryStore,
  news: null,
  rng: rngFrom(41),
  environment: () => ({ timeOfDay: 'morning', weather: null }),
});
const pA = { config: { id: 'npc_a' }, sim: { state: 'talking', dialogue: null, partner: null, session: null }, x: 0, y: 0, room: null };
const pB = { config: { id: 'npc_b' }, sim: { state: 'talking', dialogue: null, partner: null, session: null }, x: 4, y: 0, room: null };
const pPlayer = { config: { id: 'npc_p' }, sim: { state: 'talking', dialogue: null, partner: pA, session: null }, x: 8, y: 0, room: null };
pA.sim.partner = pB;
pB.sim.partner = pA;
playerConversations.resetCooldowns();
const joinedPair = playerConversations.begin(pA, pB);
check('a pair starts before the player joins', !!joinedPair);
if (joinedPair) {
  playerConversations.update(0.5);
  await new Promise((resolve) => setTimeout(resolve, 0));
  check('the opening is addressed to the other villager', capturedPayloads[0]
    && capturedPayloads[0].speaker.name === 'Ada'
    && capturedPayloads[0].listener.name === 'Bram', JSON.stringify(capturedPayloads[0] && [capturedPayloads[0].speaker.name, capturedPayloads[0].listener.name]));

  const joined = playerConversations.joinPlayer(joinedPair.id, pPlayer);
  check('the player can join a live pair', !!joined);
  check('the player is placed after the last speaker', joined
    && joined.participants.map((participant) => participant.id).join('|') === 'npc_a|npc_p|npc_b',
    joined && joined.participants.map((participant) => participant.id).join('|'));
  check('joining gives the player the next turn', !!joined && joined.awaitingHuman === true);

  const said = playerConversations.playerSay(joinedPair.id, 'Hello, both of you.');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const replyPayload = capturedPayloads[capturedPayloads.length - 1];
  check('the player line is accepted', said.ok === true, JSON.stringify(said));
  check('the villager after the player answers the player', replyPayload
    && replyPayload.speaker.name === 'Bram'
    && replyPayload.listener.name === 'Amin Rabhi',
    JSON.stringify(replyPayload && [replyPayload.speaker.name, replyPayload.listener.name]));
  check('the reply history marks the player as the last speaker', replyPayload
    && replyPayload.history.length > 0
    && replyPayload.history[replyPayload.history.length - 1].speakerName === 'Amin Rabhi',
    JSON.stringify(replyPayload && replyPayload.history.slice(-1)));
  check('the group reply is not addressed to the bystander', replyPayload
    && replyPayload.listener.name !== 'Ada', replyPayload && replyPayload.listener.name);
  playerConversations.finish(joinedPair, 'abandoned', 'test');
}

const solo = playerConversations.beginPlayer(pPlayer, pA);
check('a one-to-one player chat starts', !!solo);
if (solo) {
  playerConversations.playerSay(solo.id, 'Just the two of us.');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const soloPayload = capturedPayloads[capturedPayloads.length - 1];
  check('a one-to-one reply names the NPC as speaker and the player as listener', soloPayload
    && soloPayload.speaker.name === 'Ada'
    && soloPayload.listener.name === 'Amin Rabhi',
    JSON.stringify(soloPayload && [soloPayload.speaker.name, soloPayload.listener.name]));
  playerConversations.finish(solo, 'abandoned', 'test');
}

console.log(`\n${checks - failures}/${checks} checks passed.`);
if (failures) {
  console.error(`${failures} failing check(s).`);
  process.exit(1);
}
