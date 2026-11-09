// Who each villager is when they open their mouth.
//
// The ten hand-written villagers now come from js/cast.js: history, values, fears,
// voice, private business and a one-way opinion of every other villager. This module
// turns that into the profile the conversation manager hands to the model, and keeps
// the studio's editable fields working for any villager added later.
//
// A studio edit is layered on top of the cast rather than replacing it, so changing
// someone's interests in the editor does not erase their history or the way they
// speak.

import { CAST } from './cast.js';

export const PROFILE_VERSION = 2;
// A new key on purpose. The old profiles belonged to the previous cast; loading them
// would quietly bring those personalities back after the overhaul.
export const STORAGE_KEY = 'aivillage.profiles.v2';

// Adjectives the studio offers as quick-add chips.
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
  if (words.includes('sarcastic') || words.includes('funny') || words.includes('wry')) return 'wry';
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

function cleanText(value, length = 400) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, length);
}

// A complete, normalised profile for one roster entry: the cast, then anything
// already stored on the entry (a baked profile or a studio edit).
export function profileFor(entry) {
  const id = entry && entry.id ? entry.id : '';
  const base = CAST[id] || {};
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
    const own = stored[field];
    if (Array.isArray(own)) return cleanList(own);
    const fallback = [...(base[field] || []), ...(traits[field] || [])];
    return [...new Set(fallback)].slice(0, 8);
  };

  return {
    version: PROFILE_VERSION,
    id,
    name: entry && entry.name ? entry.name : 'Villager',
    personality: cleanList(entry && entry.personality ? entry.personality : (base.personality || []), 8, 24),
    backstory: cleanText((entry && entry.backstory) || base.backstory || '', 520),
    notes: cleanText((entry && entry.notes) || base.notes || '', 260),
    interests: interests.length ? interests : pickList('interests'),
    likes: likes.length ? likes : pickList('likes'),
    dislikes: dislikes.length ? dislikes : pickList('dislikes'),
    tendencies: tendencies.length ? tendencies : pickList('tendencies'),
    memories: memories.length ? memories : (base.memories || []).slice(0, 6),
    motivation: cleanText(stored.motivation || base.motivation || '', 220),
    values: cleanList(stored.values || base.values || [], 6, 60),
    fears: cleanList(stored.fears || base.fears || [], 5, 80),
    // The secret is available to the social layer, which decides when it is safe to
    // tell. It is deliberately not part of contextFor(), so an ordinary prompt cannot
    // leak it by accident.
    secret: cleanText(base.secret || stored.secret || '', 220),
    voice: cleanText(stored.voice || base.voice || '', 260),
    style,
    styleText: styleText(style),
    social,
    bonds: base.bonds ? {
      likes: [...(base.bonds.likes || [])],
      dislikes: [...(base.bonds.dislikes || [])],
      distrusts: [...(base.bonds.distrusts || [])],
      envies: [...(base.bonds.envies || [])],
      grudges: [...(base.bonds.grudges || [])],
    } : null,
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
    // order: cast defaults <- saved edits <- what the roster already carries
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

// Everything the debug panel and the conversation prompt need, without the raw roster
// entry. The secret stays out: social_context.js shares it only when trust allows.
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
    motivation: profile.motivation,
    values: profile.values,
    fears: profile.fears,
    voice: profile.voice,
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
