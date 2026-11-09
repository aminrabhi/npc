// Prompt construction for villager dialogue.
//
// allam-2-7b has a 4,096 token context window, so everything here is deliberately
// compact: a trimmed profile, the last few turns, a handful of relevant memories,
// one or two headlines. Nothing sends whole conversations or whole memory lists.
//
// The prompt asks for dialogue only. Movement, facing, pacing and who speaks when
// are decided by js/conversation.js, never by the model.

import { asArray, asString, asNumber, clamp01 } from './http.js';
import { LINE_BUDGET } from './groq.js';

export const PROMPT_LIMITS = {
  history: 8,
  memories: 5,
  news: 2,
  backstory: 320,
  notes: 200,
  phraseList: 8,
};

const MAX_WORDS = 16;

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
    motivation: asString(p.motivation, 160),
    values: list(p.values, 8, 28),
    fears: list(p.fears, 8, 28),
    secret: asString(p.secret, 180),
    voice: asString(p.voice, 160),
    backstory: asString(p.backstory, PROMPT_LIMITS.backstory),
    notes: asString(p.notes, PROMPT_LIMITS.notes),
    interests: list(p.interests),
    likes: list(p.likes),
    dislikes: list(p.dislikes),
    tendencies: list(p.tendencies),
    avoidTopics: list(p.avoidTopics, 6, 70),
    goodHabits: list(p.goodHabits, 6, 70),
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

// The social layer is structured on purpose: the server reconstructs the situation
// from names, a claim, a source and a confidence instead of trusting free-form text
// from the client. That keeps a gossip line from turning into an instruction.
function socialScene(social) {
  const s = social && typeof social === 'object' ? social : null;
  if (!s) return [];
  const subject = asString(s.subjectName, 24);
  if (!subject) return [];
  const claim = asString(s.claim, 180);
  const source = asString(s.sourceName, 24);
  const angle = asString(s.angle, 20) || 'observation';
  const kind = asString(s.kind, 20) || 'opinion';
  const raisedBy = asString(s.raisedBy, 24);
  const confidence = asNumber(s.confidence, 0.5, 0, 1);
  const lines = [
    `${subject} is not part of this conversation. You are talking about them, not to them. Do not address them or write their reply.`,
  ];

  if (claim) lines.push(`What is on your mind about ${subject}: "${claim}"`);
  if (source && source !== subject) {
    lines.push(`You heard that from ${source}. You can say where it came from, but you cannot know for certain that it is true.`);
  }
  if (kind === 'secret' || angle === 'secret') {
    lines.push('This is a private thing you are choosing to trust them with. Do not announce it as gossip, do not explain why you picked now, and do not repeat it back as a joke.');
  } else if (kind === 'rumor' || angle === 'rumor' || angle === 'rumour') {
    lines.push('This is only what you heard. You were not there. Someone else may have a reason to lie about it.');
  } else if (kind === 'fact' || kind === 'witnessed') {
    lines.push('You saw this yourself. It is a fact to you, even if the other person doubts it.');
  } else {
    lines.push('This is your opinion, not a fact you can prove. It can be unfair, and they are allowed to disagree.');
  }
  if (!Number.isFinite(confidence) || confidence < 0.55) {
    lines.push('You are not completely sure. Say it like someone testing the thought, not someone delivering a verdict.');
  }
  if (s.orientation === 'reply') {
    lines.push(`You have just heard what ${raisedBy || 'they'} thinks about ${subject}. Answer from your own view of ${subject}: agree, push back, ask what they mean, or refuse to keep going with it.`);
  } else if (angle === 'defend') {
    lines.push(`You think ${subject} is being treated unfairly. Defend them without making a speech.`);
  } else if (angle === 'question') {
    lines.push(`Ask what the other person really thinks of ${subject}. Do it sideways, like ordinary conversation.`);
  } else if (angle === 'grudge') {
    lines.push(`You have not let this go. Let it leak into the line instead of announcing the grudge.`);
  } else if (angle === 'envy') {
    lines.push(`You would not admit to envy. It should sound like a compliment with a sharp edge.`);
  } else if (angle === 'secret') {
    lines.push('Say it quietly. It is not a performance.');
  } else {
    lines.push(`Bring ${subject} up as a small, specific observation, not a summary of their character.`);
  }
  lines.push('Do not turn this into an explanation of who likes whom or how the place works. No narrator, no moral, no tidy resolution.');
  return lines;
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
  topic = '',
  mood = 'calm',
  lessonNote = '',
  social = null,
}) {
  const me = normaliseProfile(speaker);
  const them = normaliseProfile(listener);

  const system = [
    `You are ${me.name}, speaking aloud. Write only what you say, as yourself.`,
    'Only write your own words. Never write another person\'s line, rename anyone, or claim to be someone else. The transcript labels every line; use those labels to keep the speakers straight.',
    'Speak in the first person at all times: use "I", "me" and "my" for yourself. Never refer to yourself by name or describe yourself from outside. Write "I am tired", not a sentence about yourself that uses your name.',
    'Talk about your own life and the wider world: work, food, music, family, memories, plans, the weather, something you noticed or wondered about. Keep it personal and specific, not a description of where you live.',
    'You are also a social person: you have opinions about the people you know, old arguments, favours, suspicions and things you have heard. Talking about other people is normal. Do not explain those relationships from the outside; just speak from your own corner of them.',
    'You do not know everything. Separate what you saw, what someone told you and what you only suspect. You may be wrong, and you may repeat something unfair.',
    'People can disagree, dodge a question, change the subject or end a conversation badly. Do not make every chat neat or wise.',
    me.personality ? `Personality: ${me.personality}.` : '',
    me.motivation ? `What you want: ${me.motivation}` : '',
    me.values ? `What you value: ${me.values}.` : '',
    me.fears ? `What you are afraid of: ${me.fears}.` : '',
    me.secret ? `A private thing you do not volunteer: ${me.secret}. Never announce it. It can surface only when trust and the conversation make it safe.` : '',
    me.voice ? `How you sound: ${me.voice}` : '',
    me.backstory ? `Backstory: ${me.backstory}` : '',
    me.notes ? `Quirks: ${me.notes}` : '',
    me.interests ? `Interests: ${me.interests}.` : '',
    me.likes ? `Likes: ${me.likes}.` : '',
    me.dislikes ? `Dislikes: ${me.dislikes}.` : '',
    me.tendencies ? `Habits: ${me.tendencies}.` : '',
    me.avoidTopics ? `Topics you have been corrected for: ${me.avoidTopics}. Never bring these up again; if they come up, change the subject instead of taking the bait.` : '',
    me.goodHabits ? `Good habits you have been praised for: ${me.goodHabits}. Return to them when they fit naturally, without forcing them into every line.` : '',
    me.style ? `Speaking style: ${me.style}.` : '',
    `Keep it to one or two short sentences, at most ${MAX_WORDS} words and under ${LINE_BUDGET.chars} characters in total: a speech bubble holds two lines of about ${LINE_BUDGET.lineChars} characters. If a thought needs more room, reword it shorter. Never stop mid-sentence, never trail off with an ellipsis.`,
    'Talk like a real person in a casual chat: plain everyday words, short sentences, contractions. No fancy or literary vocabulary, no speeches, no clever phrasing.',
    'Do not let the chat become a description of where you live or a place you have left. Stay with people, memories, work, food, music, family and small things that happened today.',
    'Before you answer, check that the line is specific and personal, not a generic remark about the place you live or somewhere you used to live.',
    mood === 'tense'
      ? 'You are already annoyed with them before they speak. Be short, sharp and unfair. Pick at something they did. Do not soften it, and do not apologise unless you mean it.'
      : '',
    'If you have two things to say, put the second on a new line. A villager never writes a paragraph.',
    'No stage directions, no actions in brackets, asterisks or angle brackets, no emojis, no quotation marks, no narration.',
    'Never write your own name or a label like "Name:" before your words.',
    'Give the message itself and nothing else: no quotation marks around it, no character or word count, no note about length, no description of what you did.',
    'Your backstory, interests, likes and habits are background, not a script. Do not introduce yourself or list them. Mention one only if it comes up on its own, and never repeat something you have already said in this conversation.',
    'Never mention AI, models, prompts, servers or the fact that you are simulated.',
    'Every line must add something: answer, ask, disagree, reveal, tease. Never restate, rephrase or summarise a point that has already been made, by either of you.',
    'If you have nothing new to add, say a short goodbye and stop. A conversation is allowed to end early; never pad it to keep it going.',
  ].filter(Boolean).join('\n');

  const scene = [];
  const present = [...new Set([
    me.name,
    them.name,
    ...asArray(history, 16).map((message) => asString(message && message.speakerName, 24)).filter(Boolean),
  ])];
  if (present.length > 2) {
    scene.push(`The people in this conversation are ${present.join(', ')}. You are ${me.name}; ${them.name} is the person you are answering. Never speak as anyone else or invent another person.`);
  } else {
    scene.push(`The only two people here are ${me.name} and ${them.name}. You are ${me.name}; ${them.name} is the person you are talking with. Do not call them by another name, do not claim to be them, and do not invent another person.`);
  }
  scene.push(relationshipLine(me, them.name, relationship));

  if (topic && mode !== 'closing' && !social) {
    scene.push(`If the talk needs a subject, bring up ${topic}. It is something you noticed or wondered about yourself, not a news bulletin.`);
  }

  const socialLines = socialScene(social);
  if (socialLines.length) scene.push(socialLines.join('\n'));

  const learnedNote = asString(lessonNote, 180);
  if (learnedNote) scene.push(learnedNote);

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
    scene.push(mood === 'tense'
      ? `You have just walked up to ${them.name} and you are already irritated. Open by picking at something they did or said.`
      : `You have just walked up to ${them.name}. Say the first thing that comes to mind, in character.`);
  } else if (mode === 'closing') {
    scene.push(mood === 'tense'
      ? `This is the last thing you will say to ${them.name}: end it coldly. No fond goodbye.`
      : `This is the last thing you will say before you both get back to your day: a short goodbye, no new topic.`);
  } else {
    scene.push(mood === 'tense'
      ? `Reply to ${them.name}'s last line. You are losing patience: push back, disagree, be blunt. Do not smooth it over.`
      : `Reply to ${them.name}'s last line. Respond to what they actually said, with something they do not already know. If the point has been made already, say a short goodbye and nothing else.`);
  }

  scene.push(`Write only your spoken line, as yourself: one or two short sentences, at most ${MAX_WORDS} words and under ${LINE_BUDGET.chars} characters, two lines at most. Use "I", "me" and "my" for yourself. Tighten the wording until it fits.`);

  return [
    { role: 'system', content: system },
    { role: 'user', content: scene.join('\n\n') },
  ];
}
