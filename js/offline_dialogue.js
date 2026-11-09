// The offline dialogue engine.
//
// Simulora must stay a living village when Groq is rate-limited, unreachable or out of
// tokens. This module is the floor under the simulation: a procedural writer that turns
// what the village already knows into a line of speech.
//
// It uses only things the simulation owns: names, personality traits, backstory,
// interests, likes and dislikes, the directional relationship record, remembered
// moments (shared ones first), the weather, the time of day, a cached headline and what
// the speaker was doing a moment ago. Nothing here makes a network request, so a line
// always arrives.
//
// Variety is structural, not luck:
//   * a large bank of templates per category, with band- and style-specific variants
//   * a template cannot be used again for a long time, and never twice for one pair
//   * a line that mostly repeats words already said is rejected and redrawn
//   * topics go on cooldown after use, so a pair that meets often still has news
//
// The output is deliberately the same shape the model path produces: one or two short
// sentences that fit a two-line bubble.

export const CATEGORIES = [
  'greeting',
  'casual',
  'friendship',
  'bestfriend',
  'shared',
  'memory',
  'weather',
  'news',
  'personal',
  'disagreement',
  'positive',
  'ending',
  'gossip',
  'question',
  'defend',
  'rumor',
  'secret',
  'grudge',
  'envy',
];

// How long a template rests before it may be drawn again, and how long a subject
// stays off the table after a conversation used it.
const TEMPLATE_COOLDOWN_MS = 40 * 60_000;
const PAIR_COOLDOWN_MS = 3 * 60 * 60_000;
const TOPIC_COOLDOWN_MS = 90 * 60_000;
const RECENT_TEXTS = 40;
const MAX_CHARS = 110;

// ---------------------------------------------------------------- template banks
// Placeholders: {me} {them} {shared} {interest} {like} {dislike} {memory}
// {weather} {time} {news} {activity} {topic}. Kept short on purpose: a bubble holds two
// lines of about 52 characters, and a line that does not fit is never spoken.
const GREETING = {
  neutral: [
    '{them}. Morning. I do not think we have spoken properly.',
    'Hello. You are {them}, are you not? I am {me}.',
    'We have not met. I am {me}. What do you do with your days?',
    'You look new to me. I am {me}.',
    'Hm. Hello. I am not good at this part, so I am {me}.',
    'Oh. Hello. I was somewhere else entirely.',
  ],
  warm: [
    '{them}. Not seen you in a while.',
    'There you are. I was wondering if you were about.',
    'Well, look at that. How have you been keeping?',
    'You. Good. I have something to tell you.',
    'Hello, {them}. Come and stand out of the way with me a minute.',
    'Ah, I was just thinking about you. Not badly, for once.',
  ],
  close: [
    '{them}. You look well. What is new with you?',
    'There you are. I was about to give up on you.',
    'Look who it is. Sit down, you are making me tired.',
    'You. Good. I have been meaning to ask you something.',
    'Finally. Someone worth talking to.',
    'Hello, you. What has the day done to you so far?',
  ],
  best: [
    '{them}. You. Good. I was getting bored of my own thoughts.',
    'There you are. I knew you would turn up eventually.',
    'You do not have to say hello, you know. I know it is you.',
    'Ah, my favourite problem. What is going on with you?',
    'You. Good. I have decided to tell you something and not regret it.',
    'Hello, trouble. I was hoping you would come this way.',
  ],
  cold: [
    'Oh. It is you.',
    'Yes? What is it?',
    'You. I was having a nice day until now.',
    'Hm. Go on then.',
    'I saw you coming and hoped I was wrong.',
    'What do you want?',
  ],
};

const CASUAL = [
  'It is strange how a day can go by and nothing happens in it at all.',
  'I have been thinking about getting rid of half my things.',
  'Do you ever just stop and look at what you are doing?',
  'Nothing much today. Nothing much is fine, mostly.',
  'I slept badly, so forgive me if I am slow.',
  'I have decided to be less serious about most things.',
  'Everyone keeps telling me I look tired. I am tired.',
  'I have started walking a longer way home for no reason.',
  'The week has gone by like nothing. What day is it?',
  'I am hungry and it is not even a proper meal time.',
  'I keep meaning to write things down and never do.',
  'Some days I think I have too much time and no idea what to do with it.',
  'Have you noticed how quiet it gets when nobody is around?',
  'I lost an argument to myself this morning.',
  'Nothing is broken today. That is as good as it gets.',
  'I have been putting off a phone call for three days.',
  'I woke up before the alarm and just lay there, thinking about nothing.',
  'Do you ever get halfway through a job and forget why you started it?',
  'I have been carrying the same list around for a week now.',
  'I nearly said something honest today. I stopped myself.',
  'It is a strange day when nothing goes wrong. Makes me nervous.',
  'I keep seeing the same bird in the same place. It is probably a coincidence.',
  'I have no plans and I am oddly pleased about it.',
  'I sat down for five minutes this morning and lost an hour.',
  'I have been awake since five and achieved nothing at all.',
  'Someone asked me a simple question and I forgot the answer.',
  'I am trying to be more patient. It is going badly.',
  'I have a whole afternoon free and no idea what for.',
  'It is funny what you get used to after a while.',
  'I keep thinking it is Thursday. It is not Thursday.',
  'I have been {activity} all morning. I am not proud of it.',
  'You catch me {activity}. It is that kind of day.',
  'Nothing to report. {activity}, mostly.',
  'I keep coming back to {topic}. I do not know why.',
  'Do you ever think about {topic}? I do, too often.',
  'I have been thinking about {topic} again.',
  'I— sorry, I lost my thread. What were we saying?',
  'I mean, it is fine. It is not fine, but it is fine.',
  'You know what? Forget it. It does not matter.',
  'That came out wrong. I did not mean it like that.',
  'I have no idea. I really do not.',
  'Do not ask me. I am the last person who knows.',
  'I keep going back and forth on it.',
  'It sounds stupid when I say it out loud.',
  'Maybe I am overthinking it. I usually am.',
  'I had something clever to say and then forgot it.',
  'What? No. Go on, then.',
];

const FRIENDSHIP = [
  'You know, you are the one person I do not have to explain myself to.',
  'If you ever need a hand with something, ask me. I mean it.',
  'I trust your opinion more than most, which is a strange thing to admit.',
  'You were right about that, and I have not forgotten it.',
  'It is good to have someone around who does not take everything so seriously.',
  'I like how you do not make a big thing out of anything.',
  'You have a way of making a bad day smaller. Do not let it go to your head.',
  'I would rather hear bad news from you than good news from anyone else.',
  'You never make me explain the joke. I like that.',
  'If I am quiet, it is not because of you. Mostly.',
  'You are one of the few people I do not have to perform for.',
  'I would lend you money and not chase you for it. Do not test that.',
  'It is easier to say the real thing to you than to most.',
  'We do not have to agree for this to work.',
];

const BESTFRIEND = [
  'You never have to knock. You know that.',
  'I tell you things I would not tell anyone else, and you never make it weird.',
  'Do you remember when this was all a terrible idea? We were right.',
  'I could sit here with you and say nothing at all and it would still be a good day.',
  'You are the only one who notices when I am pretending to be fine.',
  'If I have to hear anyone talk about their problems, I am glad it is you.',
  'You and me, we are not normal, and I would not change it.',
  'Do not go anywhere. I mean it. I would have to find someone else.',
  'You know what I am going to say before I say it. It is unsettling.',
  'I would be lost here without you, and I would never admit that twice.',
  'You are the only person I would sit in silence with for an hour.',
  'We have been through enough that this counts as small talk.',
  'If you are ever in trouble, you come to me first. Promise me.',
  'I do not keep many people. I kept you.',
];

const SHARED = [
  'You still into {shared}? I have not touched it in weeks.',
  'I was thinking about {shared} today and I thought of you, honestly.',
  'We are the only two people here who care about {shared}.',
  'Have you done anything with {shared} lately? I want to start again.',
  'It is a relief to meet someone who gets {shared} without a long explanation.',
  'I saw something about {shared} and nearly came to find you.',
  'We should do something about {shared}. Not now. But sometime.',
  'You are the reason I got back into {shared}. Blame yourself.',
  'Nobody else here would understand why I care about {shared}.',
  'I saw something today that made me think of {shared} and then of you.',
  'We should argue about {shared} properly one day.',
  'You are better at {shared} than you let on.',
  'I gave up on {shared} once. You talked me out of it.',
  'It is nice to talk about {shared} without explaining it first.',
];

const MEMORY = [
  'I still think about that time with you. {memory}',
  'You remember when we talked about it? {memory}',
  'Something reminded me of you today. {memory}',
  'I have not forgotten. {memory}',
  'Do you ever think back to that? {memory}',
  'It comes back to me now and then. {memory}',
  'I remember more of that than I let on. {memory}',
  'That stayed with me. {memory}',
  'You probably do not remember this. {memory}',
  'I was thinking about this earlier. {memory}',
  'It is odd what sticks in your head. {memory}',
  'I brought this up before, I know. {memory}',
  'That is one I keep. {memory}',
  'Nothing reminded me of it. It just came back. {memory}',
];

const WEATHER = [
  '{weather} today. It makes me want to stay in and do nothing.',
  'Do you think {weather} is going to last? I have plans I would rather not keep.',
  'I have been out in {weather} all morning. I am done with it.',
  'I quite like {weather}, actually. Nobody bothers me in it.',
  'My knees said it would be like this. They are never wrong.',
  'You can tell the season is turning. I felt it this morning.',
  'I stood outside for a while just listening to it. Strange thing to do.',
  'Whatever the sky is doing, it is doing it all day apparently.',
  'It is the kind of {weather} that makes a cup of tea feel serious.',
  'I have given up dressing for it. {weather} does not care either way.',
  'I got caught out in it earlier. My own fault.',
  'I am not going anywhere until {weather} gives up.',
  'The sky cannot decide. It has been like this all week.',
  'You would think I would be used to {weather} by now.',
  'I like the sound it makes when I am indoors.',
  'My washing is out. I am choosing to believe it will hold.',
  'It is not the weather that bothers me. It is everyone talking about it.',
];

const NEWS = [
  'Did you hear about this? {news}',
  'I caught the news earlier. {news}',
  'Somebody mentioned this and I have not stopped thinking about it. {news}',
  'I do not usually follow it, but this got me. {news}',
  'It is on the radio every hour. {news}',
  'That headline about the world outside is doing my head in. {news}',
  'I heard this and thought of you, for some reason. {news}',
  'You know more about this than me. {news}',
  'I cannot make sense of it. {news}',
  'It is the sort of thing I would normally ignore. {news}',
  'Somebody at the shop was arguing about it. {news}',
];

const PERSONAL = [
  'I have been spending too much on {interest}, if I am honest.',
  'You know what I cannot stand? {dislike}. It makes me unreasonable.',
  'I had a good hour with {like} this morning. That was the whole day.',
  'It is the small things. {like}, a decent cup of tea, nobody asking me questions.',
  'I do not know why I care so much about {interest}. I just do.',
  'I would give up a lot to have more time for {interest}.',
  'Someone told me I talk about {interest} too much. I disagreed strongly.',
  'I am trying something new with {interest}. It is going badly, but I am trying.',
  'If I never had to hear about {dislike} again, I would die happy.',
  'My whole mood depends on whether I get my {like}. It is embarrassing.',
  'I have been thinking about {interest} more than my actual problems.',
  'There is no good reason for it. I just love {like}.',
  'I keep promising myself I will be better about {interest}. Tomorrow.',
  'The older I get, the less patience I have for {dislike}.',
  'I have been meaning to get back into {interest} for months.',
  'I cannot explain my taste in {interest}. People find it odd.',
  'I spent money I do not have on {interest} again.',
  'The one thing that never disappoints me is {like}.',
  'I will never understand the appeal of {dislike}.',
  'If you want to know me, ask about {interest}. I will not stop.',
  'I gave up {dislike} for a month once. It was the best month.',
  'I am not a complicated person. {like} and a bit of peace.',
  'I could talk about {interest} until you walked away.',
  'You know what I have never understood? {dislike}.',
  'I had a whole plan about {interest} and then I sat down instead.',
  'People think I am strange because of {interest}. They are right.',
  'I would rather have {like} than most of what people chase.',
  'The best part of my day was {like}. That is the whole report.',
];

const DISAGREEMENT = {
  soft: [
    'I do not agree with that, and I am not going to pretend I do.',
    'That is not how I see it at all.',
    'You are wrong about that. I am not being unkind, just clear.',
    'Hm. No. I do not think so.',
    'I would let that go if it were anyone else, but no.',
    'Say that again and I will still disagree with you.',
  ],
  cold: [
    'You always do this. Say the thing and then act surprised.',
    'I am not in the mood for your version of events.',
    'This is going nowhere, like usual with you.',
    'Do not start. I have heard it before.',
    'You are wasting both our time.',
    'I would rather stand in the rain than finish this conversation.',
  ],
  tense: [
    'You never listen. You wait for a gap and then talk over it.',
    'I am sick of being the reasonable one in this.',
    'Do not tell me what I meant. I was there.',
    'You are being impossible, and you know it.',
    'I should not have stopped to talk to you.',
    'Forget it. You are not going to hear me anyway.',
  ],
};

const POSITIVE = [
  'That is the best thing I have heard all week. Thank you.',
  'You are good at this, you know. Talking to people.',
  'I am glad you said that. I was worried I was the only one.',
  'That is kind of you. I did not expect it.',
  'Well. That has genuinely made me feel better.',
  'You are a good sort. Do not let anyone tell you otherwise.',
  'I am glad we did this. I mean that.',
  'You have been decent to me. I notice these things.',
  'That was a good thing you did. I saw it.',
  'I do not say this often, so hear it once: thank you.',
  'You made that easier than it had any right to be.',
  'I was in a foul mood and you fixed it without trying.',
  'You are easy to have around. That is a compliment.',
  'I would trust you with the awkward jobs.',
];

const ENDING = {
  warm: [
    'Right. I should let you get on. Come and find me later.',
    'I will leave you to it. Take care of yourself.',
    'Go on then. Mind how you go.',
    'Off you go. I will be here, doing nothing as usual.',
    'Good talking. Really. See you soon.',
    'Right. Back to it. Do not be a stranger.',
  ],
  plain: [
    'Anyway. I should get back to it.',
    'Right, that is me. See you about.',
    'I have things to do. They are not important, but still.',
    'Enough from me. Take care.',
    'I will be off. Good to talk.',
    'Later, then.',
  ],
  cold: [
    'I am done with this. Goodbye.',
    'We are finished here.',
    'Do not bother next time.',
    'Right. I am going. Do not follow.',
    'I have nothing else to say to you.',
    'Leave it. Just leave it.',
  ],
};

// ---------------------------------------------------------- third-person talk
// These are the conversations the village was missing: someone else is the subject.
// {subject} is a person who is not in the conversation, {claim} is what the speaker
// believes or heard, and {source} is where it came from. None of them explains a
// relationship from the outside; the opinion has to do the work.
const GOSSIP = [
  'You know how {subject} is. {claim}',
  'I am not saying anything about {subject}. I am saying I have started noticing.',
  'It is not the thing itself. It is the way {subject} does it.',
  'You have seen how {subject} gets. What is that about?',
  'I tried with {subject}. I am finished trying.',
  'At least {subject} is consistent. Consistently like that.',
  'Do not repeat this, but {subject} has been on my mind.',
  'I do not have a problem with {subject}. I have a problem with the performance.',
  'Someone needs to tell {subject} to stop. It is not going to be me.',
  'I used to defend {subject}. I am running out of material.',
  'You can like {subject}. I am not asking you to agree with me.',
  'It is the little things with {subject}. They add up.',
];

const QUESTION = [
  'What do you actually think of {subject}? Do not give me the polite answer.',
  'Has {subject} said anything about me? You can tell me.',
  'Why does {subject} get away with that?',
  'Do you trust {subject}? I cannot decide.',
  'Be honest. Am I wrong about {subject}?',
  'You talk to {subject} more than I do. What is going on there?',
  'What did {subject} mean by that? I keep going back to it.',
  'If {subject} told you something, would you tell me?',
  'Does {subject} seem different to you lately?',
  'What is {subject}’s problem with me?',
  'You would tell me if {subject} said something? I am asking properly.',
  'What is the worst thing about {subject}? Be specific.',
];

const DEFEND = [
  'Everyone has decided {subject} is a problem. I think that is convenient.',
  '{subject} is not perfect. Neither are you.',
  'I have heard what people say about {subject}. Most of it is nonsense.',
  'You can dislike {subject}. You do not get to make things up.',
  'I have seen {subject} do good things when nobody was watching.',
  'It is easy to judge {subject} from over here.',
  'Say it to {subject}’s face, then. Not to me.',
  'I am not saying {subject} is innocent. I am saying I do not believe you.',
  'That is not the {subject} I know.',
  'You are all very sure for people who were not there.',
  'I would rather hear it from {subject} than from the rest of you.',
  'You can be angry with {subject} without turning it into a story.',
];

const RUMOR = [
  'I heard this about {subject}: {claim}',
  'Someone told me {claim}. It was about {subject}.',
  'I do not know if it is true. {claim}. That is what I heard about {subject}.',
  'What have you heard about {subject}? I heard {claim}',
  'This stays between us. {claim}',
  '{subject} has been telling people something. I heard {claim}',
  'I am only repeating what I was told. {claim}',
  'If that is true about {subject}, a lot of things make sense.',
  'I was not there. I only know what I heard: {claim}',
  'Do not go repeating this, but it came from {source}: {claim}',
];

const SECRET = [
  'Do not repeat this. {claim}',
  'I have not told anyone this. {claim}',
  'You can keep a thing quiet, can’t you? {claim}',
  'I am only saying this because I trust you. {claim}',
  'This does not leave this conversation. {claim}',
  'I do not want advice. I just need someone to know. {claim}',
  'You know something about me now. {claim}',
  'I have been carrying this alone. {claim}',
];

const GRUDGE = [
  '{subject} still owes me an apology. We both know it.',
  'I am not bringing it up. I am just saying I remember.',
  'They can act friendly. I know what {subject} said.',
  'It was not the thing. It was the way {subject} did it.',
  'I have let it go. I have not forgotten it. There is a difference.',
  'Everyone else moved on. Good for them.',
  'I do not need an apology. I need {subject} to stop pretending it did not happen.',
  'You can tell {subject} I said that. See what they do.',
  'It has been months. It still gets me.',
  'I am not going to be the one who makes it easy.',
];

const ENVY = [
  'Must be nice to be {subject}. Nothing ever sticks.',
  '{subject} makes it look easy. I hate that.',
  'I do not want to be {subject}. I want the part where everyone trusts them.',
  'Some people get the room without asking.',
  'It is not envy. It is an observation. {subject} gets away with everything.',
  'I would not trade places. I would trade the reception.',
  'You know what {subject} has that I do not? Timing.',
  'I am happy for {subject}. That is the worst part.',
  'Everyone asks {subject}. Nobody asks me.',
  'I have done the same work. Somehow it counts more when {subject} does it.',
];

// A style may colour a greeting, but never rewrites the whole line: two villagers
// must still sound like themselves rather than like a template with a label.
const STYLE_PREFIX = {
  warm: ['Oh, {them}.', 'There you are.'],
  blunt: ['Right.', 'Look.'],
  chatty: ['Hey!', 'Oh good.'],
  wry: ['Well, well.', 'Hm.'],
  quiet: ['Hm.', 'Oh.'],
  formal: ['Good day.', 'Ah.'],
  kid: ['Hi!', 'Ooh.'],
  plain: ['Morning.', 'Hm.'],
};

const CHANGED = {
  warmer: [
    'You have been better company than usual lately.',
    'I have decided you are alright. Do not make me regret it.',
    'It has been good, talking to you these days.',
  ],
  colder: [
    'We have been off with each other and I do not know why.',
    'I have been avoiding you, if I am honest.',
    'Something has changed between us. You have noticed it too.',
  ],
};

// -------------------------------------------------------------------- utilities
const STOP = new Set([
  'the', 'and', 'that', 'this', 'with', 'have', 'has', 'had', 'you', 'your',
  'for', 'but', 'not', 'are', 'was', 'were', 'they', 'them', 'then', 'there',
  'here', 'what', 'when', 'who', 'why', 'how', 'just', 'like', 'about', 'from',
  'into', 'been', 'being', 'would', 'could', 'should', 'will', 'does', 'did',
  'his', 'her', 'its', 'our', 'their', 'him', 'she', 'too', 'very', 'much',
  'some', 'any', 'all', 'one', 'two', 'also', 'say', 'says', 'said', 'know',
  'think', 'well', 'yeah', 'yes', 'me', 'my', 'i', 'a', 'an', 'to', 'of',
  'it', 'is', 'in', 'on', 'at', 'as', 'be', 'so', 'do', 'if', 'or', 'up',
]);

function words(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !STOP.has(word));
}

function similar(a, b) {
  const left = new Set(words(a));
  const right = new Set(words(b));
  if (left.size < 3 || right.size < 3) return false;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.min(left.size, right.size) >= 0.6;
}

export function bandOf(relationship) {
  const category = relationship && relationship.category ? relationship.category : 'stranger';
  if (category === 'enemy' || category === 'disliked') return 'cold';
  if (category === 'best friend') return 'best';
  if (category === 'friend' || category === 'close friend') return 'close';
  if (category === 'friendly' || category === 'acquaintance') return 'warm';
  return 'neutral';
}

function timePhrase(phase) {
  return {
    morning: 'this morning',
    day: 'today',
    evening: 'this evening',
    night: 'tonight',
  }[phase] || 'today';
}

function weatherPhrase(weather) {
  if (!weather) return '';
  if (weather.wet) return 'this rain';
  if (weather.snowy) return 'the snow';
  const label = String(weather.label || '').toLowerCase();
  if (!label) return '';
  if (label.includes('storm')) return 'this storm';
  if (label.includes('fog')) return 'the fog';
  if (label.includes('clear')) return 'this clear sky';
  if (label.includes('cloud') || label.includes('overcast')) return 'these clouds';
  return `the ${label}`;
}

// Short on purpose: this gets substituted inside a bubble-sized sentence.
function activityPhrase(activity) {
  return {
    walking: 'walking about',
    watching: 'standing about',
    chilling: 'sitting in',
    talking: 'standing about talking',
    sleeping: 'half asleep',
    inside: 'stuck indoors',
  }[activity] || 'out and about';
}

function clip(text, max = 68) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[.,;:!?]$/, '')}`;
}

function stripEnd(text) {
  return String(text || '').replace(/[.!?]$/, '').trim();
}

function oneLine(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function weighted(rng, options) {
  const total = options.reduce((sum, option) => sum + option.weight, 0);
  if (total <= 0) return options[0];
  let roll = rng() * total;
  for (const option of options) {
    roll -= option.weight;
    if (roll <= 0) return option;
  }
  return options[options.length - 1];
}

// Does this line fit a two-line bubble? Whole words only: a truncated line sounds
// worse than a different one.
export function fitsBubble(text, maxChars = MAX_CHARS) {
  const value = oneLine(text);
  if (value.length > maxChars) return false;
  const lines = [];
  let current = '';
  for (const word of value.split(' ')) {
    if (word.length > 52) return false;
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > 52) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.length <= 2;
}

// ------------------------------------------------------------------ the engine
export function createOfflineDialogue({
  rng = Math.random,
  now = () => Date.now(),
  history = RECENT_TEXTS,
} = {}) {
  const usedTemplates = new Map(); // id -> timestamp
  const usedLines = []; // { text, at }
  const pairTemplates = new Map(); // pairKey -> Map(id -> at)
  const topicReadyAt = new Map();
  const stats = {
    lines: 0,
    byCategory: {},
    lastCategory: null,
    lastTemplate: null,
  };

  function note(text) {
    usedLines.push({ text, at: now() });
    if (usedLines.length > history) usedLines.shift();
  }

  function pairKeyOf(me, them) {
    return [me && me.id ? me.id : me && me.name, them && them.id ? them.id : them && them.name]
      .map((value) => String(value || ''))
      .sort()
      .join('|');
  }

  function recentlySaid(text) {
    for (const entry of usedLines) {
      if (similar(text, entry.text)) return true;
    }
    return false;
  }

  function templateBlocked(id, pairKey) {
    const at = usedTemplates.get(id) || 0;
    if (now() - at < TEMPLATE_COOLDOWN_MS) return true;
    const perPair = pairTemplates.get(pairKey);
    if (perPair && now() - (perPair.get(id) || 0) < PAIR_COOLDOWN_MS) return true;
    return false;
  }

  function markTemplate(id, pairKey) {
    usedTemplates.set(id, now());
    if (!pairTemplates.has(pairKey)) pairTemplates.set(pairKey, new Map());
    pairTemplates.get(pairKey).set(id, now());
  }

  function candidates(bank, ctx, pairKey) {
    const list = bank.map((text, index) => ({ id: `${ctx.category}:${index}`, text }));
    const free = list.filter((entry) => !templateBlocked(entry.id, pairKey));
    return free.length ? free : list;
  }

  function pick(bank, ctx, pairKey) {
    const list = candidates(bank, ctx, pairKey);
    // shuffle a copy so the same template does not win every time in the same bank
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    for (const entry of list) {
      const rendered = render(entry.text, ctx);
      if (!rendered) continue;
      if (!fitsBubble(rendered)) continue;
      if (recentlySaid(rendered)) continue;
      if (ctx.recentLines && ctx.recentLines.some((line) => similar(rendered, line))) continue;
      markTemplate(entry.id, pairKey);
      return { id: entry.id, text: rendered };
    }
    // Every template in this bank has been used recently. Rotate through the least
    // recently used ones rather than collapsing onto the first: a long run of talk
    // should still move through the whole bank before it repeats.
    const lastUsed = (entry) => Math.max(
      usedTemplates.get(entry.id) || 0,
      (pairTemplates.get(pairKey) && pairTemplates.get(pairKey).get(entry.id)) || 0,
    );
    const rotated = list.slice().sort((a, b) => lastUsed(a) - lastUsed(b));
    const lastLine = usedLines[usedLines.length - 1];
    for (const entry of rotated) {
      const rendered = render(entry.text, ctx);
      if (!rendered || !fitsBubble(rendered)) continue;
      if (lastLine && (rendered === lastLine.text || similar(rendered, lastLine.text))) continue;
      markTemplate(entry.id, pairKey);
      return { id: entry.id, text: rendered };
    }
    return null;
  }

  function render(template, ctx) {
    let text = String(template);
    const swap = {
      me: ctx.me && ctx.me.name,
      them: ctx.them && ctx.them.name,
      shared: ctx.shared ? ctx.shared.toLowerCase() : '',
      interest: ctx.interest ? ctx.interest.toLowerCase() : '',
      like: ctx.like ? ctx.like.toLowerCase() : '',
      dislike: ctx.dislike ? ctx.dislike.toLowerCase() : '',
      memory: ctx.memory ? stripEnd(clip(ctx.memory, 62)) : '',
      subject: ctx.subject || '',
      claim: ctx.claim ? stripEnd(clip(ctx.claim, 64)) : '',
      source: ctx.source || '',
      weather: ctx.weatherText || '',
      time: ctx.timeText || '',
      news: ctx.news ? stripEnd(clip(ctx.news, 64)) : '',
      activity: ctx.activityText || '',
      topic: ctx.topic ? clip(ctx.topic, 56) : '',
    };
    let changed = false;
    text = text.replace(/\{(\w+)\}/g, (match, key) => {
      const value = swap[key];
      if (value === undefined || value === '') {
        changed = true;
        return match;
      }
      return value;
    });
    if (changed) return '';
    return oneLine(text);
  }

  function chooseCategory(ctx) {
    const has = {
      shared: !!ctx.shared,
      memory: !!ctx.memory,
      weather: !!ctx.weatherText,
      news: !!ctx.news,
      personal: !!(ctx.interest || ctx.like || ctx.dislike),
    };
    const options = [];
    const add = (category, weight) => { if (weight > 0) options.push({ category, weight }); };

    const socialCategory = ctx.socialCategory || (ctx.social && ctx.social.category) || '';
    if (ctx.mode === 'closing') {
      add('ending', 10);
    } else if (socialCategory) {
      if (ctx.mode === 'opening') {
        add(socialCategory, 12);
        if (ctx.mood === 'tense') add('disagreement', 5);
        else add('greeting', 2);
      } else if (ctx.mood === 'tense') {
        add('disagreement', 8);
        add(socialCategory, 6);
        add('ending', 1);
      } else {
        add(socialCategory, 8);
        add('question', 2);
        add('disagreement', 1);
        add('casual', 1);
      }
    } else if (ctx.mode === 'opening') {
      if (ctx.mood === 'tense') {
        add('disagreement', 8);
        add('greeting', 2);
      } else {
        add('greeting', 10);
        add('weather', has.weather ? 2 : 0);
        add('news', has.news ? 2 : 0);
        add('personal', has.personal ? 2 : 0);
        add('shared', has.shared ? 1 : 0);
      }
    } else if (ctx.mood === 'tense') {
      add('disagreement', 10);
      add('ending', 1);
    } else {
      add('casual', 6);
      add('personal', has.personal ? 5 : 0);
      add('shared', has.shared ? 4 : 0);
      add('memory', has.memory ? 4 : 0);
      add('weather', has.weather ? 2 : 0);
      add('news', has.news ? 2 : 0);
      add('friendship', ctx.band === 'warm' || ctx.band === 'close' || ctx.band === 'best' ? 3 : 0);
      add('bestfriend', ctx.band === 'best' ? 3 : 0);
      add('positive', 2);
      add('greeting', 1);
    }
    return weighted(rng, options).category;
  }

  function bankFor(category, ctx) {
    switch (category) {
      case 'greeting':
        return GREETING[ctx.band] || GREETING.neutral;
      case 'ending':
        return ctx.mood === 'tense' || ctx.band === 'cold' ? ENDING.cold : (ctx.band === 'close' || ctx.band === 'best' || ctx.band === 'warm' ? ENDING.warm : ENDING.plain);
      case 'disagreement':
        if (ctx.mood === 'tense') return DISAGREEMENT.tense;
        if (ctx.band === 'cold') return DISAGREEMENT.cold;
        return DISAGREEMENT.soft;
      case 'positive':
        return POSITIVE;
      case 'gossip':
        return GOSSIP;
      case 'question':
        return QUESTION;
      case 'defend':
        return DEFEND;
      case 'rumor':
        return RUMOR;
      case 'secret':
        return SECRET;
      case 'grudge':
        return GRUDGE;
      case 'envy':
        return ENVY;
      case 'friendship':
        return FRIENDSHIP;
      case 'bestfriend':
        return BESTFRIEND;
      case 'shared':
        return SHARED;
      case 'memory':
        return MEMORY;
      case 'weather':
        return WEATHER;
      case 'news':
        return NEWS;
      case 'personal':
        return PERSONAL;
      default:
        return CASUAL;
    }
  }

  function chooseMemory(me, them, memories) {
    if (memories && memories.length) {
      // a memory about this person beats a memory about anyone else
      const shared = memories.filter((memory) => memory.aboutNpcId && memory.aboutNpcId === (them && them.id));
      const pool = shared.length ? shared : memories;
      const memory = pool[Math.floor(rng() * pool.length)];
      return memory && memory.description ? memory.description : '';
    }
    // No stored memory yet: a short backstory line is the next best thing a villager
    // could have on their mind. A long one would not fit a bubble, so it is skipped.
    const story = me && me.backstory ? String(me.backstory).trim() : '';
    return story.length >= 20 && story.length <= 80 ? story : '';
  }

  function choose(list) {
    if (!list || !list.length) return '';
    return list[Math.floor(rng() * list.length)];
  }

  // One spoken line. `ctx` carries everything the village knows; the engine never
  // reaches outside it.
  function line(input = {}) {
    const me = input.me || { name: 'Someone' };
    const them = input.them || { name: 'someone' };
    const band = bandOf(input.relationship);
    const sharedList = [];
    const mine = new Set((me.interests || []).map((entry) => String(entry).toLowerCase()));
    for (const interest of them.interests || []) {
      if (mine.has(String(interest).toLowerCase())) sharedList.push(String(interest));
    }

    const ctx = {
      me,
      them,
      band,
      mood: input.mood === 'tense' ? 'tense' : 'calm',
      mode: input.mode || 'reply',
      shared: choose(sharedList),
      interest: choose(me.interests),
      like: choose(me.likes),
      dislike: choose(me.dislikes),
      memory: chooseMemory(me, them, input.memories),
      weatherText: weatherPhrase(input.weather),
      timeText: timePhrase(input.timeOfDay),
      news: input.news && input.news.headline ? input.news.headline : '',
      topic: input.topic || '',
      social: input.social || null,
      socialCategory: input.social && input.social.category ? input.social.category : '',
      subject: input.social ? input.social.subjectName || '' : '',
      claim: input.social ? input.social.claim || '' : '',
      source: input.social ? input.social.sourceName || '' : '',
      activityText: activityPhrase(input.activity),
      recentLines: Array.isArray(input.recentLines) ? input.recentLines : [],
    };

    // A tense conversation can also be about something real; the disagreement bank
    // already carries the friction, so the category stays as chosen.
    let category = input.category || chooseCategory(ctx);
    let entry = pick(bankFor(category, ctx), { ...ctx, category }, pairKeyOf(me, them));
    if (!entry) {
      category = 'casual';
      entry = pick(CASUAL, { ...ctx, category }, pairKeyOf(me, them));
    }

    let text = entry ? entry.text : '';
    // A style prefix only on greetings, and only sometimes: a tic on every line is
    // worse than no personality at all.
    if (text && category === 'greeting' && rng() < 0.3) {
      const prefixes = STYLE_PREFIX[me.style] || [];
      const prefix = choose(prefixes);
      const rendered = prefix ? render(prefix, ctx) : '';
      if (rendered && fitsBubble(`${rendered} ${text}`) && !recentlySaid(`${rendered} ${text}`)) {
        text = `${rendered} ${text}`;
      }
    }
    if (!text) {
      // The absolute floor: a short, neutral line that fits any bubble.
      text = choose(['Right.', 'Hm.', 'Go on then.', 'Fair enough.', 'I know.']);
    }

    stats.lines += 1;
    stats.byCategory[category] = (stats.byCategory[category] || 0) + 1;
    stats.lastCategory = category;
    stats.lastTemplate = entry ? entry.id : null;
    note(text);
    return { text, category, band };
  }

  function noteTopic(topic) {
    if (!topic) return;
    topicReadyAt.set(topic, now() + TOPIC_COOLDOWN_MS);
  }

  function topicReady(topic) {
    return !topic || now() >= (topicReadyAt.get(topic) || 0);
  }

  return {
    line,
    note,
    noteTopic,
    topicReady,
    categories: () => CATEGORIES.slice(),
    status: () => ({
      ...stats,
      templates: Object.keys(usedTemplates).length,
      recent: usedLines.length,
      topicCooldowns: [...topicReadyAt.values()].filter((at) => at > now()).length,
    }),
    reset: () => {
      usedTemplates.clear();
      pairTemplates.clear();
      usedLines.length = 0;
      topicReadyAt.clear();
    },
  };
}

// A short phrase for the debug panel: who is talking and why.
export function relationshipLabel(band) {
  return {
    cold: 'cold',
    neutral: 'new to each other',
    warm: 'friendly',
    close: 'friends',
    best: 'best friends',
  }[band] || band;
}
