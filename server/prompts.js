// Prompt construction for villager dialogue.
//
// allam-2-7b has a 4,096 token context window, so everything here is deliberately
// compact: a trimmed profile, the last few turns, a handful of relevant memories,
// one or two headlines. Nothing sends whole conversations or whole memory lists.
//
// The prompt asks for dialogue only. Movement, facing, pacing and who speaks when
// are decided by js/conversation.js, never by the model.

import { asArray, asString, asNumber, clamp01 } from './http.js';

export const PROMPT_LIMITS = {
  history: 8,
  memories: 5,
  news: 2,
  backstory: 320,
  notes: 200,
  phraseList: 8,
};

const MAX_WORDS = 24;

function list(value, max = PROMPT_LIMITS.phraseList, length = 40) {
  const items = asArray(value, max)
    .map((entry) => asString(entry, length))
    .filter(Boolean);
  return items.length ? items.join(', ') : '';
}

export function normaliseProfile(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const conversation = p.conversation && typeof p.conversation === 'object' ? p.conversation : {};
  const social = p.social && typeof p.social === 'object' ? p.social : {};
  return {
    name: asString(p.name, 24) || 'Villager',
    personality: list(p.personality, 8, 24),
    backstory: asString(p.backstory, PROMPT_LIMITS.backstory),
    notes: asString(p.notes, PROMPT_LIMITS.notes),
    interests: list(p.interests),
    likes: list(p.likes),
    dislikes: list(p.dislikes),
    tendencies: list(p.tendencies),
    style: asString(conversation.style, 40),
    memories: asArray(p.memories, 4)
      .map((entry) => asString(entry, 110))
      .filter(Boolean),
    newsInterest: clamp01(social.newsInterest, 0.25),
    sociability: clamp01(social.sociability, 0.5),
  };
}

function relationshipLine(profile, otherName, relationship) {
  if (!relationship) return `${otherName} is someone you have only just met.`;
  const category = asString(relationship.category, 24) || 'acquaintance';
  const score = Math.round(asNumber(relationship.score, 0, -100, 100));
  const trust = clamp01(relationship.trust, 0.3);
  const familiarity = clamp01(relationship.familiarity, 0.2);
  const friendly = trust >= 0.6 ? 'you trust them' : trust <= 0.25 ? 'you keep your guard up' : 'you are still working them out';
  const knows = familiarity >= 0.6 ? 'you know them well' : familiarity <= 0.2 ? 'you hardly know them' : 'you know them a little';
  return `You see ${otherName} as a ${category} (warmth ${score}/100, ${friendly}, ${knows}).`;
}

function memoryLines(memories) {
  const lines = asArray(memories, PROMPT_LIMITS.memories)
    .map((entry) => {
      const text = asString(entry && entry.description, 120);
      if (!text) return '';
      const about = asString(entry.aboutName, 24);
      return about ? `- ${text} (with ${about})` : `- ${text}`;
    })
    .filter(Boolean);
  return lines;
}

function newsLines(news) {
  return asArray(news, PROMPT_LIMITS.news)
    .map((entry) => {
      const headline = asString(entry && entry.headline, 120);
      if (!headline) return '';
      const summary = asString(entry.summary, 110);
      const category = asString(entry.category, 20);
      return `- "${headline}"${category ? ` [${category}]` : ''}${summary ? ` - ${summary}` : ''}`;
    })
    .filter(Boolean);
}

function transcript(history) {
  const rows = asArray(history, 16)
    .map((message) => {
      const speaker = asString(message && message.speakerName, 24) || 'Someone';
      const text = asString(message && message.text, 220);
      return text ? `${speaker}: ${text}` : '';
    })
    .filter(Boolean)
    .slice(-PROMPT_LIMITS.history);
  return rows.join('\n');
}

export function buildMessages({
  mode = 'reply',
  speaker,
  listener,
  history = [],
  memories = [],
  relationship = null,
  news = [],
  recentLines = [],
  relationshipChange = null,
}) {
  const me = normaliseProfile(speaker);
  const them = normaliseProfile(listener);

  const system = [
    `You are ${me.name}, a villager in a small pixel-art village. Write only ${me.name}'s spoken words.`,
    me.personality ? `Personality: ${me.personality}.` : '',
    me.backstory ? `Backstory: ${me.backstory}` : '',
    me.notes ? `Quirks: ${me.notes}` : '',
    me.interests ? `Interests: ${me.interests}.` : '',
    me.likes ? `Likes: ${me.likes}.` : '',
    me.dislikes ? `Dislikes: ${me.dislikes}.` : '',
    me.tendencies ? `Habits: ${me.tendencies}.` : '',
    me.style ? `Speaking style: ${me.style}.` : '',
    `Keep it to one short sentence, at most ${MAX_WORDS} words. Ordinary village speech.`,
    'No stage directions, no actions, no emojis, no quotation marks, no narration.',
    'Never mention AI, models, prompts, servers or the fact that you are simulated.',
    'Never repeat a line you have already said in this conversation.',
  ].filter(Boolean).join('\n');

  const scene = [];
  scene.push(`You are talking with ${them.name}.`);
  scene.push(relationshipLine(me, them.name, relationship));

  if (relationshipChange) {
    const kind = asString(relationshipChange.kind, 20);
    const note = asString(relationshipChange.note, 90);
    if (kind && note) scene.push(`Lately: ${note}`);
  }

  const past = memoryLines(memories);
  if (past.length) scene.push(`Things you remember:\n${past.join('\n')}`);

  const meMemories = me.memories.map((line) => `- ${line}`).join('\n');
  if (meMemories) scene.push(`Your own history:\n${meMemories}`);

  const headlines = newsLines(news);
  if (headlines.length) {
    scene.push(`Headlines you heard on the radio this morning (BBC News):\n${headlines.join('\n')}\nYou only know what the headline said. Never claim you saw it happen.`);
  }

  if (recentLines.length) {
    scene.push(`Do not open with any of these lines you used before: ${asArray(recentLines, 4).map((line) => `"${asString(line, 90)}"`).join('; ')}`);
  }

  const historyText = transcript(history);
  if (historyText) scene.push(`Conversation so far:\n${historyText}`);

  if (mode === 'opening') {
    scene.push(`You have just walked up to ${them.name}. Say the first thing that comes to mind, in character.`);
  } else if (mode === 'closing') {
    scene.push(`This is the last thing you will say before you both get back to your day. Wrap it up naturally, no new topic.`);
  } else {
    scene.push(`Reply to ${them.name}'s last line. Respond to what they actually said.`);
  }

  scene.push(`Write only ${me.name}'s line. One sentence.`);

  return [
    { role: 'system', content: system },
    { role: 'user', content: scene.join('\n\n') },
  ];
}
