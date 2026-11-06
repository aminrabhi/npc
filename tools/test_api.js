// End-to-end tests for the API routes, against the local test doubles.
//
//   npm run test:api
//
// Two servers are started: one configured (mock Groq + mock Supabase + mock feed) and
// one deliberately unconfigured, so both the working path and the "no keys yet" path
// are covered.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitiseLine, sanitiseMessages } from '../server/groq.js';
import { buildMessages } from '../server/prompts.js';
import { generateLine } from '../api/chat.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOCK_PORT = 4210;
const CONFIGURED_PORT = 4211;
const BARE_PORT = 4212;

let failures = 0;
let checks = 0;

function check(name, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

function waitFor(url, timeoutMs = 8000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        await fetch(url);
        resolve();
      } catch {
        if (Date.now() - started > timeoutMs) reject(new Error(`timed out waiting for ${url}`));
        else setTimeout(tick, 120);
      }
    };
    tick();
  });
}

function start(script, args, env) {
  const child = spawn(process.execPath, [path.join(root, script), ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (data) => process.stderr.write(`[${script}] ${data}`));
  return child;
}

const configuredEnv = {
  GROQ_API_KEY: 'test-key',
  GROQ_MODEL: 'allam-2-7b',
  GROQ_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/openai/v1`,
  SUPABASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role',
  BBC_FEEDS: `http://127.0.0.1:${MOCK_PORT}/news/rss.xml`,
};

const bareEnv = {
  GROQ_API_KEY: '',
  GROQ_MODEL: '',
  GROQ_BASE_URL: '',
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',
  SUPABASE_SERVICE_ROLE_KEY: '',
};

const children = [];

try {
  children.push(start('tools/mock_backends.js', [String(MOCK_PORT)], {}));
  await waitFor(`http://127.0.0.1:${MOCK_PORT}/_stats`);

  children.push(start('tools/api_server.js', [String(CONFIGURED_PORT)], configuredEnv));
  children.push(start('tools/api_server.js', [String(BARE_PORT)], bareEnv));
  await waitFor(`http://127.0.0.1:${CONFIGURED_PORT}/api/status`);
  await waitFor(`http://127.0.0.1:${BARE_PORT}/api/status`);

  const base = `http://127.0.0.1:${CONFIGURED_PORT}`;
  const bare = `http://127.0.0.1:${BARE_PORT}`;
  const post = (url, body) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  console.log('\nstatus');
  const status = await (await fetch(`${base}/api/status`)).json();
  check('groq reported configured', status.groq && status.groq.configured === true);
  check('model is allam-2-7b', status.groq && status.groq.model === 'allam-2-7b', status.groq && status.groq.model);
  check('supabase reported configured', status.supabase && status.supabase.configured === true);
  check('no secret values in the payload', !JSON.stringify(status).includes('test-key'));

  const bareStatus = await (await fetch(`${bare}/api/status`)).json();
  check('unconfigured server reports groq off', bareStatus.groq && bareStatus.groq.configured === false);
  check('unconfigured server names the missing vars', Array.isArray(bareStatus.missing) && bareStatus.missing.includes('GROQ_API_KEY'));

  console.log('\nline shaping');
  const twoLines = sanitiseLine('Morning, you are up early.\nThe tomatoes look good today.');
  check('a reply with a break keeps both lines', twoLines.split('\n').length === 2, JSON.stringify(twoLines));
  const longLine = sanitiseLine('I was thinking about the tomatoes and how the weather has been strange lately and whether we should plant them earlier this year before the frost comes in.');
  check('a long reply is re-flowed, not one wide line', longLine.split('\n').length === 2, JSON.stringify(longLine));
  check('no line is wider than a speech bubble', longLine.split('\n').every((line) => line.length <= 52), JSON.stringify(longLine));
  const runaway = sanitiseLine('word '.repeat(200));
  check('a runaway reply is capped', runaway.replace(/\n/g, ' ').length <= 110, `${runaway.length}`);
  check('a third line is dropped', sanitiseLine('One thing.\nTwo things.\nThree things.').split('\n').length === 2);
  const stage = sanitiseLine('<acts confused> Tiny: I thought we agreed about the fence.');
  check('stage directions and speaker labels are stripped', !/[<>]/.test(stage) && !/Tiny/.test(stage) && /fence/.test(stage), stage);
  const secondLabel = sanitiseLine('Morning, you are up early.\nTiny: The fence is broken again.');
  check('a speaker label is stripped from any line, not only the first', !/Tiny/.test(secondLabel), secondLabel);
  const emoji = sanitiseLine('The tomatoes are doing well 😀🍅 today.');
  check('emoji are stripped from a line', !/[\u{1F300}-\u{1FAFF}]/u.test(emoji) && /tomatoes/.test(emoji), emoji);
  const counted = sanitiseLine('Mama Green: "I could eat a whole pie." (110 characters)');
  check('labels, quotes and character counts are stripped', !/["“”]/.test(counted) && !/character/i.test(counted) && /pie/.test(counted), counted);
  const countedTail = sanitiseLine('That sounds about right. 98/110 characters');
  check('a trailing character count is dropped', !/character/i.test(countedTail) && /right/.test(countedTail), countedTail);
  const quotedTwo = sanitiseLine('"Morning, you are up early."\n"The tomatoes look good."');
  check('quotes around each line are stripped', !/["“”]/.test(quotedTwo), quotedTwo);
  const split = sanitiseMessages('The weather has been strange lately and the tomatoes are late this year. I was thinking we should plant them earlier before the frost comes in and cover the beds at night so nothing freezes.');
  check('a long reply becomes a second message, not a cut-off', split.length >= 2, `${split.length}`);
  check('each split message still fits a bubble', split.every((part) => part.length <= 110), JSON.stringify(split));
  check('a split keeps the finished sentence at the end', /[.!?]$/.test(split[split.length - 1]), JSON.stringify(split[split.length - 1]));

  console.log('\nvillage life');
  const fake = (text) => ({ text, extra: [], model: 'allam-2-7b' });
  let attempts = 0;
  const villageLine = await generateLine({
    messages: [],
    complete: async () => {
      attempts += 1;
      return fake('The whole village was at the square today.');
    },
  });
  check('a village line is spoken as written', villageLine.text === 'The whole village was at the square today.', villageLine.text);
  check('a village line is not retried or cleaned', villageLine.retried === false && villageLine.cleaned === false && attempts === 1, `${attempts} ${JSON.stringify(villageLine)}`);

  const prompt = buildMessages({ speaker: { name: 'Mama Green' }, listener: { name: 'Timmy' }, mode: 'opening' });
  check('prompt asks for one or two short sentences', /one or two short sentences/i.test(prompt[0].content));
  check('prompt asks for a line break on a second thought', /new line/i.test(prompt[0].content));
  check('prompt tells the model not to recite its backstory', /background, not a script/i.test(prompt[0].content));
  check('prompt asks for the message only, with no count', /no character or word count/i.test(prompt[0].content));
  check('prompt asks for plain casual words', /plain everyday words/i.test(prompt[0].content));
  check('prompt keeps talk personal', /Talk about your own life/i.test(prompt[0].content));
  check('prompt asks for specific personal detail', /personal and specific/i.test(prompt[0].content));
  check('prompt does not steer toward village or city life', !/\b(village|city)\b/i.test(prompt[0].content), prompt[0].content);
  check('prompt redirects away from where they live', /where you live/i.test(prompt[0].content));

  const learnedPrompt = buildMessages({
    speaker: { name: 'Mama Green', avoidTopics: ['a bet you lost'], goodHabits: ['the sea'] },
    listener: { name: 'Timmy' },
    mode: 'reply',
    lessonNote: 'You were just corrected for bringing up a bet you lost. Drop that subject.',
  });
  check('prompt carries corrected topics', /corrected for: a bet you lost/i.test(learnedPrompt[0].content), learnedPrompt[0].content);
  check('prompt carries praised habits', /praised for: the sea/i.test(learnedPrompt[0].content), learnedPrompt[0].content);
  check('prompt carries the immediate lesson', /Drop that subject/i.test(learnedPrompt[1].content), learnedPrompt[1].content);

  console.log('\nchat');
  const conversation = {
    conversationId: 'c_test_1',
    mode: 'opening',
    messageCount: 0,
    speaker: {
      name: 'Mama Green',
      personality: ['sweet', 'gentle'],
      backstory: 'An old lady who likes to garden.',
      interests: ['gardening', 'tomatoes'],
      social: { sociability: 0.8, newsInterest: 0.2 },
    },
    listener: { name: 'Timmy', personality: ['playful'], interests: ['games'] },
    history: [],
    memories: [],
    relationship: { score: 12, category: 'acquaintance', trust: 0.4, familiarity: 0.3 },
    news: [],
    recentLines: [],
  };

  const chat = await post(`${base}/api/chat`, conversation);
  const chatBody = await chat.json();
  check('chat returns 200', chat.status === 200, `status ${chat.status}`);
  check('chat returns a line', chatBody.ok === true && typeof chatBody.message.text === 'string' && chatBody.message.text.length > 0);
  check('chat reports the configured model', chatBody.message && chatBody.message.model === 'allam-2-7b');
  check('line contains no technical leakage', !/\b(AI|Groq|prompt|API)\b/.test(chatBody.message ? chatBody.message.text : ''));
  check('a normal line is not marked as cleaned', chatBody.message.cleaned === false && chatBody.message.retried === false);

  const closing = await (await post(`${base}/api/chat`, { ...conversation, conversationId: 'c_test_2', mode: 'closing', messageCount: 6 })).json();
  check('closing mode produces a line', closing.ok === true && closing.message.text.length > 0);

  const learnedChat = await post(`${base}/api/chat`, {
    ...conversation,
    conversationId: 'c_test_learned',
    speaker: { ...conversation.speaker, avoidTopics: ['a bet you lost'], goodHabits: ['the sea'] },
    lessonNote: 'You were just praised for talking about the sea.',
  });
  const learnedChatBody = await learnedChat.json();
  check('chat accepts learned topic context', learnedChat.status === 200 && learnedChatBody.ok === true, JSON.stringify(learnedChatBody.error || learnedChatBody));

  const tooLong = await post(`${base}/api/chat`, { ...conversation, messageCount: 12 });
  const tooLongBody = await tooLong.json();
  check('message cap enforced', tooLong.status === 409 && tooLongBody.error.code === 'conversation_full', `status ${tooLong.status}`);

  const noId = await post(`${base}/api/chat`, { ...conversation, conversationId: '' });
  check('missing conversation id rejected', noId.status === 400);

  const badMode = await post(`${base}/api/chat`, { ...conversation, mode: 'shout' });
  check('unknown mode rejected', badMode.status === 400);

  const wrongMethod = await fetch(`${base}/api/chat`);
  check('GET on chat is 405', wrongMethod.status === 405, `status ${wrongMethod.status}`);

  const bareChat = await post(`${bare}/api/chat`, conversation);
  const bareChatBody = await bareChat.json();
  check('unconfigured chat explains itself', bareChat.status === 503 && bareChatBody.error.code === 'groq_not_configured', `status ${bareChat.status}`);
  check('unconfigured error names GROQ_API_KEY', /GROQ_API_KEY/.test(bareChatBody.error.message + JSON.stringify(bareChatBody.error)));

  console.log('\nvillage line over HTTP');
  const villageMock = 4214;
  const villageApi = 4215;
  children.push(start('tools/mock_backends.js', [String(villageMock)], { MOCK_GROQ: 'village' }));
  await waitFor(`http://127.0.0.1:${villageMock}/_stats`);
  children.push(start('tools/api_server.js', [String(villageApi)], {
    ...configuredEnv,
    GROQ_BASE_URL: `http://127.0.0.1:${villageMock}/openai/v1`,
  }));
  await waitFor(`http://127.0.0.1:${villageApi}/api/status`);
  const villageChat = await post(`http://127.0.0.1:${villageApi}/api/chat`, { ...conversation, conversationId: 'c_village_1' });
  const villageBody = await villageChat.json();
  check('a village line is allowed over HTTP', villageChat.status === 200 && !!villageBody.message && /village/i.test(villageBody.message.text), JSON.stringify(villageBody.message || villageBody.error));
  check('the village line is not flagged as retried', villageBody.message && villageBody.message.retried === false && villageBody.message.cleaned === false, JSON.stringify(villageBody.message));

  console.log('\nmodel misconfiguration');
  const wrongModelChild = start('tools/api_server.js', ['4213'], { ...configuredEnv, GROQ_MODEL: 'not-a-model' });
  children.push(wrongModelChild);
  await waitFor('http://127.0.0.1:4213/api/status');
  const wrongModel = await post('http://127.0.0.1:4213/api/chat', conversation);
  const wrongModelBody = await wrongModel.json();
  check('bad model reports the API error', wrongModelBody.error && wrongModelBody.error.code === 'groq_model_unavailable', JSON.stringify(wrongModelBody.error));
  check('bad model names the configuration point', /GROQ_MODEL/.test(wrongModelBody.error.message));

  console.log('\nmemories (automatic persistence)');
  const memoryRows = [
    { id: 'm_test_1', npcId: 'npc_04', aboutNpcId: 'npc_08', kind: 'shared', description: 'Found out Timmy likes bugs too.', importance: 0.6 },
    { id: 'm_test_2', npcId: 'npc_08', aboutNpcId: 'npc_04', kind: 'milestone', description: 'Met Mama Green properly.', importance: 0.7 },
  ];
  const memorySave = await (await post(`${base}/api/memories`, { memories: memoryRows })).json();
  check('memories saved', memorySave.ok === true && memorySave.saved === 2, JSON.stringify(memorySave));
  const memoryAgain = await (await post(`${base}/api/memories`, { memories: memoryRows })).json();
  check('duplicate memories are not written twice', memoryAgain.ok === true && memoryAgain.saved === 0, JSON.stringify(memoryAgain));

  const memoryRead = await (await fetch(`${base}/api/memories?npcId=npc_04&limit=10`)).json();
  check('memories can be read back', memoryRead.ok === true && memoryRead.memories.length >= 1);
  check('the villager\'s own memory is returned', memoryRead.memories.some((memory) => memory.npcId === 'npc_04'));
  check('shared memory about npc_04 is included', memoryRead.memories.some((memory) => memory.aboutNpcId === 'npc_04'));
  check('memories carry their importance', memoryRead.memories.every((memory) => typeof memory.importance === 'number'));

  const badMemory = await post(`${base}/api/memories`, { memories: [{ description: 'no id' }] });
  check('malformed memory rejected', badMemory.status === 400);

  console.log('\nrelationships (automatic persistence, directional)');
  const relSave = await (await post(`${base}/api/relationships`, {
    updates: [
      { npcId: 'npc_04', otherId: 'npc_08', score: 52, trust: 0.6, familiarity: 0.5, dislike: 0, category: 'nonsense' },
      { npcId: 'npc_08', otherId: 'npc_04', score: 20, trust: 0.35, familiarity: 0.2, dislike: 0.1 },
    ],
  })).json();
  check('relationships saved', relSave.ok === true && relSave.saved === 2, JSON.stringify(relSave));
  const a = relSave.relationships.find((row) => row.npcId === 'npc_04');
  const b = relSave.relationships.find((row) => row.npcId === 'npc_08');
  check('direction A is a friend', a && a.category === 'friend', a && a.category);
  check('direction B is a different category', b && b.category !== a.category, b && b.category);
  check('a bogus category was re-derived', a && a.category !== 'nonsense');

  const relUpsert = await (await post(`${base}/api/relationships`, {
    updates: [{ npcId: 'npc_04', otherId: 'npc_08', score: 90, trust: 0.8, familiarity: 0.7, dislike: 0 }],
  })).json();
  const stats = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/_stats`)).json();
  check('re-saving updates the same row', stats.tables.village_npc_relationships === 2, JSON.stringify(stats.tables));
  check('best friend is reachable', relUpsert.relationships[0].category === 'best friend', relUpsert.relationships[0].category);

  console.log('\nmanual transcript saving');
  const transcript = {
    conversation: {
      id: 'c_save_1',
      initiatorId: 'npc_04',
      responderId: 'npc_08',
      participants: [{ id: 'npc_04', name: 'Mama Green' }, { id: 'npc_08', name: 'Timmy' }],
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      outcome: 'complete',
      relationshipContext: { changes: [] },
      newsRefs: [],
      memories: [{ kind: 'shared', description: 'bugs' }],
    },
    messages: [
      { id: 'c_save_1_1', speakerId: 'npc_04', speakerName: 'Mama Green', text: 'Hello dear.', number: 1 },
      { id: 'c_save_1_2', speakerId: 'npc_08', speakerName: 'Timmy', text: 'Hi! Guess what!', number: 2 },
      { id: 'c_save_1_3', speakerId: 'npc_04', speakerName: 'Mama Green', text: 'Tell me, then.', number: 3 },
    ],
  };

  const save = await post(`${base}/api/conversations`, transcript);
  const saveBody = await save.json();
  check('transcript saved', save.status === 200 && saveBody.ok === true && saveBody.savedMessages === 3, JSON.stringify(saveBody.error || {}));
  check('not reported as already saved', saveBody.alreadySaved === false);

  const saveAgain = await (await post(`${base}/api/conversations`, transcript)).json();
  check('second save does not duplicate', saveAgain.alreadySaved === true);

  const list = await (await fetch(`${base}/api/conversations?list=1`)).json();
  check('saved transcript listed', list.ok === true && list.conversations.some((row) => row.id === 'c_save_1'));

  const one = await (await fetch(`${base}/api/conversations?id=c_save_1`)).json();
  check('saved transcript reads back', one.ok === true && one.messages.length === 3);
  check('message order preserved', one.messages.map((message) => message.number).join(',') === '1,2,3');

  const missing = await fetch(`${base}/api/conversations?id=c_nope`);
  check('unknown transcript is 404', missing.status === 404);

  console.log('\nnews');
  const news = await (await fetch(`${base}/api/news`)).json();
  check('headlines parsed from the feed', news.ok === true && news.items.length === 3, `${news.items && news.items.length}`);
  check('headline carries a link', news.items[0].url.includes('bbc.co.uk'));
  check('attribution present', news.attribution && news.attribution.source === 'BBC News');
  const cached = await (await fetch(`${base}/api/news`)).json();
  check('second request served from cache', cached.cached === true && cached.items.length === 3);

  // The real BBC feed wraps titles and descriptions in CDATA. That wrapper used to be
  // swallowed as if it were a tag, which emptied every headline on a live feed while a
  // plain-text test feed still passed.
  const cdata = news.items.find((item) => item.headline === 'Village wins regional gardening prize');
  check('CDATA headline survives tag stripping', !!cdata);
  check('CDATA summary keeps its words', !!cdata && cdata.summary.includes('exceptional'));
  check('no CDATA residue in any item', news.items.every((item) => !/CDATA|\]\]>/.test(`${item.headline} ${item.summary}`)));
  check('entity-escaped link decoded', news.items.some((item) => item.url.includes('at_medium=RSS')));

  console.log('\nunconfigured persistence');
  const bareMemory = await post(`${bare}/api/memories`, { memories: memoryRows });
  const bareMemoryBody = await bareMemory.json();
  check('memory save explains missing supabase', bareMemory.status === 503 && bareMemoryBody.error.code === 'supabase_not_configured');
  const bareSave = await post(`${bare}/api/conversations`, transcript);
  const bareSaveBody = await bareSave.json();
  check('transcript save explains missing supabase', bareSave.status === 503 && bareSaveBody.error.code === 'supabase_not_configured');
} catch (error) {
  failures += 1;
  console.error('\nUnexpected failure:', error);
} finally {
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
  }
}

console.log(`\n${checks - failures}/${checks} checks passed.`);
process.exit(failures ? 1 : 0);
