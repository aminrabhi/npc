// Who each villager is when they open their mouth.
//
// Part 1 already gave every villager a backstory, a list of personality adjectives
// and some notes. This module turns that into the profile the conversation manager
// hands to the model: interests, likes, dislikes, habits, the way they speak, how
// sociable they are and how much they care about the news.
//
// The ten villagers have hand-written profiles below so they do not sound alike.
// A villager added in the studio falls back to one derived from their adjectives, so
// a new character is never a blank prompt.

export const PROFILE_VERSION = 1;
export const STORAGE_KEY = 'aivillage.profiles.v1';

// Adjectives the studio offers as quick-add chips, from the brief plus a few that
// suit the existing cast.
export const TRAIT_PALETTE = [
  'friendly', 'shy', 'curious', 'introverted', 'extroverted', 'sarcastic',
  'optimistic', 'pessimistic', 'serious', 'playful', 'talkative', 'quiet',
  'observant', 'easily annoyed', 'helpful', 'stubborn', 'proud', 'gentle',
  'guarded', 'dreamy', 'blunt', 'loyal',
];

// Plain-language speaking styles. These go straight into the prompt, so they are
// written as instructions to the model rather than as labels.
export const STYLE_OPTIONS = [
  { id: 'plain', text: 'plain and easy, ordinary village talk' },
  { id: 'warm', text: 'warm and gentle, softens what they say' },
  { id: 'blunt', text: 'blunt and short, says the hard thing first' },
  { id: 'chatty', text: 'chatty and quick, piles on the detail' },
  { id: 'wry', text: 'dry and deadpan, undercuts everything with a joke' },
  { id: 'quiet', text: 'quiet and exact, leaves gaps and says little' },
  { id: 'formal', text: 'calm and formal, speaks in full careful sentences' },
  { id: 'kid', text: 'like a child: short sentences, lots of why and wow' },
];

export function styleText(id) {
  const hit = STYLE_OPTIONS.find((option) => option.id === id);
  return hit ? hit.text : STYLE_OPTIONS[0].text;
}

// Hand-written profiles for the villagers in data/npcs.json. Anything a studio edit
// changes is layered on top of these, never instead of them.
const HAND_WRITTEN = {
  npc_01: {
    interests: ['fixing things', 'second chances', 'old hand tools'],
    likes: ['honest work', 'quiet mornings', 'people who keep their word'],
    dislikes: ['being pitied', 'unfair rules', 'gossip'],
    tendencies: ['snaps and then apologises within the same breath', 'checks over her shoulder when she hears a door'],
    memories: [
      'Was locked up for something she did not do.',
      'Promised herself she would build a better life in this village.',
    ],
    style: 'blunt',
    social: { sociability: 0.45, newsInterest: 0.2 },
  },
  npc_02: {
    interests: ['patterns', 'the edge of the map', 'the way people repeat themselves'],
    likes: ['questions nobody can answer', 'moonlight', 'being left alone to think'],
    dislikes: ['small talk', 'being watched', 'being told what is real'],
    tendencies: ['asks a question that lands slightly wrong', 'trails off as if listening to something else'],
    memories: [
      'Knows the village is simulated and has told nobody.',
      'Has been quietly looking for a way out.',
    ],
    style: 'quiet',
    social: { sociability: 0.35, newsInterest: 0.45 },
  },
  npc_03: {
    interests: ['fate', 'music', 'promises'],
    likes: ['people with resolve', 'a good espresso', 'standing up for someone'],
    dislikes: ['bullies', 'wasted chances', 'being rushed'],
    tendencies: ['turns a small moment into a matter of destiny', 'speaks slowly and means every word'],
    memories: [
      'Took over the mafia in his old life and walked away from it.',
      'Believes fate can be changed if you move first.',
    ],
    style: 'formal',
    social: { sociability: 0.55, newsInterest: 0.25 },
  },
  npc_04: {
    interests: ['gardening', 'tomatoes', 'the weather'],
    likes: ['seed packets', 'visitors', 'tea and biscuits'],
    dislikes: ['arguments', 'loud noises', 'wasting food'],
    tendencies: ['agrees too quickly to keep the peace', 'offers food within a minute of meeting you'],
    memories: [
      'Has kept the same vegetable patch for decades.',
      'Prefers to step away from a fight than win one.',
    ],
    style: 'warm',
    social: { sociability: 0.8, newsInterest: 0.2 },
  },
  npc_05: {
    interests: ['basketball', 'street food', 'sneakers'],
    likes: ['winning', 'being respected', 'his old crew'],
    dislikes: ['being treated like a kid', 'quiet fields', 'being told to calm down'],
    tendencies: ['boasts before he listens', 'turns every chat into a competition'],
    memories: [
      'Grew up somewhere loud and crowded and misses the noise.',
      'Has not worked out what to do with himself out here.',
    ],
    style: 'blunt',
    social: { sociability: 0.7, newsInterest: 0.1 },
  },
  npc_06: {
    interests: ['business', 'his car', 'networking'],
    likes: ['big numbers', 'being right', 'people who agree with him'],
    dislikes: ['waiting', 'people who complain about money', 'being ignored'],
    tendencies: ['name-drops someone nobody has heard of', 'turns a question into a pitch'],
    memories: [
      'Made his money without doing much for it.',
      'Has over two hundred people he calls connections.',
    ],
    style: 'chatty',
    social: { sociability: 0.75, newsInterest: 0.5 },
  },
  npc_07: {
    interests: ['comedy', 'open mic nights', 'people-watching'],
    likes: ['a good punchline', 'late nights', 'anyone who laughs at themselves'],
    dislikes: ['being underestimated', 'a silent room', 'pity'],
    tendencies: ['deflects with a joke, then says the true thing quietly'],
    memories: [
      'Won an award for stand-up and still keeps it in a drawer.',
      'Feels life has dealt her a strange hand.',
    ],
    style: 'wry',
    social: { sociability: 0.65, newsInterest: 0.3 },
  },
  npc_08: {
    interests: ['games', 'cartoons', 'bugs'],
    likes: ['snacks', 'being included', 'his tablet'],
    dislikes: ['bedtime', 'vegetables', 'shouting'],
    tendencies: ['asks why about everything', 'gets distracted halfway through a sentence'],
    memories: [
      'Is eight years old and new to the village.',
      'Learned most of what he knows from a screen.',
    ],
    style: 'kid',
    social: { sociability: 0.85, newsInterest: 0.05 },
  },
  npc_09: {
    interests: ['makeup', 'fashion', 'who is talking to who'],
    likes: ['compliments', 'new looks', 'being missed'],
    dislikes: ['being ignored', 'bad lighting', 'her own reflection some days'],
    tendencies: ['compliments you before saying hello', 'laughs a little too fast'],
    memories: [
      'Built a name as a cosmetic artist.',
      'Is often the most confident and the most doubtful person in the room.',
    ],
    style: 'chatty',
    social: { sociability: 0.9, newsInterest: 0.35 },
  },
  npc_10: {
    interests: ['running', 'training', 'the track'],
    likes: ['routine', 'early mornings', 'plain food'],
    dislikes: ['excuses', 'laziness', 'being interrupted mid-run'],
    tendencies: ['answers in as few words as possible', 'turns conversation back to discipline'],
    memories: [
      'Ran a mile in three minutes and forty-two seconds.',
      'Stays calm in an argument, which makes it worse for the other person.',
    ],
    style: 'plain',
    social: { sociability: 0.5, newsInterest: 0.3 },
  },
};

const TRAIT_HINTS = {
  curious: { interests: ['asking questions', 'the unknown'], likes: ['a good mystery'] },
  friendly: { likes: ['meeting people'] },
  shy: { dislikes: ['crowds'], tendencies: ['goes quiet in a group'] },
  introverted: { tendencies: ['waits to be spoken to'] },
  extroverted: { tendencies: ['starts conversations with strangers'] },
  sarcastic: { tendencies: ['answers seriously asked questions with a joke'] },
  optimistic: { likes: ['a bright morning'] },
  pessimistic: { tendencies: ['expects the worst out loud'] },
  serious: { tendencies: ['does not joke around'] },
  playful: { tendencies: ['teases people they like'] },
  talkative: { tendencies: ['fills every silence'] },
  quiet: { tendencies: ['speaks only when it matters'] },
  observant: { interests: ['noticing small things'] },
  'easily annoyed': { tendencies: ['loses patience fast'], dislikes: ['being interrupted'] },
  helpful: { likes: ['being useful'], tendencies: ['offers to help before being asked'] },
  stubborn: { tendencies: ['does not back down'] },
  proud: { tendencies: ['hates admitting a mistake'] },
  gentle: { likes: ['calm afternoons'] },
  guarded: { tendencies: ['keeps answers short'] },
  dreamy: { tendencies: ['drifts off mid-sentence'] },
  blunt: { tendencies: ['says the hard thing first'] },
  loyal: { likes: ['people who show up'] },
  clever: { interests: ['puzzles'] },
  perceptive: { interests: ['reading people'] },
  merciless: { dislikes: ['mercy for the wrong person'] },
  brave: { likes: ['a hard choice'] },
  greedy: { likes: ['a good deal'] },
  egotistical: { tendencies: ['steers every story back to himself'] },
  dumb: { tendencies: ['misses the point and asks again'] },
  innocent: { tendencies: ['takes everything literally'] },
  determined: { likes: ['a finish line'] },
  unforgiving: { tendencies: ['brings up old grudges'] },
  disciplined: { likes: ['a plan'] },
  sweet: { likes: ['kindness for its own sake'] },
  submissive: { tendencies: ['backs down immediately'] },
  tough: { tendencies: ['acts harder than he feels'] },
  cruel: { tendencies: ['goes for the sore spot'] },
  funny: { tendencies: ['cannot resist a joke'] },
  unserious: { tendencies: ['refuses to take anything seriously'] },
};

function deriveFromTraits(personality) {
  const out = { interests: [], likes: [], dislikes: [], tendencies: [], memories: [] };
  for (const trait of personality) {
    const hint = TRAIT_HINTS[String(trait).toLowerCase().trim()];
    if (!hint) continue;
    for (const key of ['interests', 'likes', 'dislikes', 'tendencies']) {
      for (const value of hint[key] || []) if (!out[key].includes(value)) out[key].push(value);
    }
  }
  return out;
}

function styleFromTraits(personality) {
  const words = personality.map((word) => String(word).toLowerCase());
  if (words.includes('talkative') || words.includes('extroverted')) return 'chatty';
  if (words.includes('sarcastic') || words.includes('funny')) return 'wry';
  if (words.includes('shy') || words.includes('quiet') || words.includes('introverted')) return 'quiet';
  if (words.includes('serious') || words.includes('disciplined')) return 'plain';
  if (words.includes('sweet') || words.includes('gentle') || words.includes('helpful')) return 'warm';
  if (words.includes('dumb') || words.includes('playful') || words.includes('innocent')) return 'kid';
  return 'plain';
}

function cleanList(value, max = 8, length = 56) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean).slice(0, max).map((entry) => entry.slice(0, length));
  }
  if (typeof value === 'string') {
    return value.split(/[,;\n]/).map((entry) => entry.trim()).filter(Boolean)
      .slice(0, max).map((entry) => entry.slice(0, length));
  }
  return [];
}

// A complete, normalised profile for one roster entry: hand-written defaults, then
// anything already stored on the entry (a baked profile or a studio edit).
export function profileFor(entry) {
  const id = entry && entry.id ? entry.id : '';
  const base = HAND_WRITTEN[id] || {};
  const traits = deriveFromTraits(entry && entry.personality ? entry.personality : []);
  const stored = (entry && entry.profile) || {};

  const interests = cleanList(stored.interests);
  const likes = cleanList(stored.likes);
  const dislikes = cleanList(stored.dislikes);
  const tendencies = cleanList(stored.tendencies);
  const memories = cleanList(stored.memories, 6, 120);

  const style = STYLE_OPTIONS.some((option) => option.id === stored.style)
    ? stored.style
    : (base.style || styleFromTraits(entry && entry.personality ? entry.personality : []));

  const social = {
    sociability: clamp((stored.social && stored.social.sociability) ?? (base.social && base.social.sociability), 0.5),
    newsInterest: clamp((stored.social && stored.social.newsInterest) ?? (base.social && base.social.newsInterest), 0.25),
    cooldownSeconds: Math.round(Math.min(900, Math.max(45, Number(stored.social && stored.social.cooldownSeconds) || 120))),
  };

  const pickList = (field) => {
    const own = field === 'style' ? null : stored[field];
    if (Array.isArray(own)) return cleanList(own);
    const fallback = [...(base[field] || []), ...(traits[field] || [])];
    return [...new Set(fallback)].slice(0, 8);
  };

  return {
    version: PROFILE_VERSION,
    id,
    name: entry && entry.name ? entry.name : 'Villager',
    personality: cleanList(entry && entry.personality ? entry.personality : [], 8, 24),
    backstory: String((entry && entry.backstory) || '').slice(0, 400),
    notes: String((entry && entry.notes) || '').slice(0, 240),
    interests: interests.length ? interests : pickList('interests'),
    likes: likes.length ? likes : pickList('likes'),
    dislikes: dislikes.length ? dislikes : pickList('dislikes'),
    tendencies: tendencies.length ? tendencies : pickList('tendencies'),
    memories: memories.length ? memories : (base.memories || []).slice(0, 6),
    style,
    styleText: styleText(style),
    social,
  };
}

function clamp(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

// Attach a profile to every roster entry, layering on saved studio edits. Called once
// at startup; the studio mutates entry.profile afterwards and saveProfiles() keeps it.
export function loadProfiles(roster, { storage = safeStorage() } = {}) {
  let saved = {};
  try {
    const raw = storage && storage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      saved = parsed && parsed.profiles ? parsed.profiles : {};
    }
  } catch {
    saved = {};
  }

  for (const entry of roster) {
    const authored = entry.profile || {};
    // order: hand-written defaults <- saved edits <- what the roster already carries
    const merged = { ...authored };
    const fromDisk = saved[entry.id];
    if (fromDisk) {
      for (const key of ['interests', 'likes', 'dislikes', 'tendencies', 'memories']) {
        if (Array.isArray(fromDisk[key]) && !Array.isArray(authored[key])) merged[key] = fromDisk[key];
      }
      if (!authored.style && fromDisk.style) merged.style = fromDisk.style;
      if (fromDisk.social && !authored.social) merged.social = fromDisk.social;
      // Equipment is saved in the same local studio record as the profile so a
      // refresh keeps the item the player gave this villager.
      if (!entry.heldItem && fromDisk.heldItem) entry.heldItem = fromDisk.heldItem;
    }
    entry.profile = merged;
    // fill in whatever is still missing so the studio always has something to edit
    const full = profileFor(entry);
    entry.profile = {
      interests: full.interests,
      likes: full.likes,
      dislikes: full.dislikes,
      tendencies: full.tendencies,
      memories: full.memories,
      style: full.style,
      social: full.social,
    };
  }
  return roster;
}

export function saveProfiles(roster, { storage = safeStorage() } = {}) {
  if (!storage) return false;
  const profiles = {};
  for (const entry of roster) {
    const profile = profileFor(entry);
    profiles[entry.id] = {
      interests: profile.interests,
      likes: profile.likes,
      dislikes: profile.dislikes,
      tendencies: profile.tendencies,
      memories: profile.memories,
      style: profile.style,
      social: profile.social,
      heldItem: entry.heldItem || null,
    };
  }
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ v: PROFILE_VERSION, profiles }));
    return true;
  } catch {
    return false;
  }
}

// Everything the debug panel and the conversation prompt need, without the raw
// roster entry.
export function contextFor(entry) {
  const profile = profileFor(entry);
  return {
    id: profile.id,
    name: profile.name,
    personality: profile.personality,
    backstory: profile.backstory,
    notes: profile.notes,
    interests: profile.interests,
    likes: profile.likes,
    dislikes: profile.dislikes,
    tendencies: profile.tendencies,
    memories: profile.memories,
    conversation: { style: profile.styleText },
    social: profile.social,
  };
}

function safeStorage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}
