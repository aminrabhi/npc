// Headless checks for the preset reactions, script parser and fight lifecycle.
//
// The village itself needs a canvas, but none of this does: the line banks are
// plain arrays, the parser is pure, and the fight manager only needs villager-shaped
// objects and a stubbed relationship store.

import assert from 'node:assert/strict';
import {
  PUNISH_LINES,
  PET_LINES,
  FIGHT_LINES,
  parseScript,
  createSocial,
} from '../js/social.js';

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok ${passed} - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const banks = { punish: PUNISH_LINES, pet: PET_LINES, fight: FIGHT_LINES };

for (const [name, bank] of Object.entries(banks)) {
  check(`${name} bank has plenty of variation`, () => {
    assert.ok(bank.length >= 16, `${name} bank only has ${bank.length} lines`);
    assert.equal(new Set(bank).size, bank.length, `${name} bank repeats a line`);
  });

  check(`${name} lines are short, clean and speech-only`, () => {
    for (const line of bank) {
      assert.ok(line.length <= 90, `${name} line too long: ${line}`);
      assert.ok(!/[*_[\]()]/.test(line), `${name} line has a stage direction: ${line}`);
      const sentences = line.match(/[.!?](?=\s|$)/g) || [];
      assert.ok(sentences.length <= 2, `${name} line has too many sentences: ${line}`);
    }
  });
}

check('script parser reads named lines', () => {
  const a = { name: 'Ada', config: { id: 'npc_1' } };
  const b = { name: 'Bo', config: { id: 'npc_2' } };
  const lines = parseScript('Ada: Hello there.\nBo: Afternoon.\nAda: Nice day.', a, b);
  assert.deepEqual(lines.map((line) => line.speakerId), ['npc_1', 'npc_2', 'npc_1']);
  assert.deepEqual(lines.map((line) => line.text), ['Hello there.', 'Afternoon.', 'Nice day.']);
});

check('script parser alternates unnamed lines', () => {
  const a = { name: 'Ada', config: { id: 'npc_1' } };
  const b = { name: 'Bo', config: { id: 'npc_2' } };
  const lines = parseScript('One.\nTwo.\nThree.', a, b);
  assert.deepEqual(lines.map((line) => line.speakerId), ['npc_1', 'npc_2', 'npc_1']);
});

check('script parser keeps colons that are not speaker labels', () => {
  const a = { name: 'Ada', config: { id: 'npc_1' } };
  const b = { name: 'Bo', config: { id: 'npc_2' } };
  const lines = parseScript('I said: not today.', a, b);
  assert.equal(lines[0].text, 'I said: not today.');
  assert.equal(lines[0].speakerId, 'npc_1');
});

check('script parser drops blank rows and caps a long script', () => {
  const a = { name: 'Ada', config: { id: 'npc_1' } };
  const b = { name: 'Bo', config: { id: 'npc_2' } };
  assert.equal(parseScript('\n\n  \n', a, b).length, 0);
  const long = Array.from({ length: 50 }, (_, i) => `Line ${i}.`).join('\n');
  assert.equal(parseScript(long, a, b).length, 30);
});

function makeNpc(id, name) {
  return {
    name,
    config: { id },
    sim: { state: 'walking', dialogue: null, session: null, partner: null },
    heldItem: null,
    room: null,
  };
}

function makeSocial(overrides = {}) {
  const npcs = [makeNpc('npc_1', 'Ada'), makeNpc('npc_2', 'Bo')];
  const applied = [];
  const social = createSocial({
    relationships: {
      category: () => 'neutral',
      applyConversation: (session, options) => applied.push({ session, options }),
    },
    getNpcs: () => npcs,
    lifestyle: {
      pose: (a, b) => {
        a.sim.state = 'talking';
        b.sim.state = 'talking';
      },
      handBack: (npc) => {
        npc.sim.state = 'walking';
        npc.sim.dialogue = null;
      },
    },
    conversations: { abandon: () => {} },
    rng: () => 0.25,
    now: () => 1000,
    ...overrides,
  });
  return { social, npcs, applied };
}

check('a fight is refused between villagers who do not dislike each other', () => {
  const { social, npcs } = makeSocial();
  const result = social.startFight(npcs[0], npcs[1]);
  assert.equal(result.ok, false);
  assert.equal(npcs[0].heldItem, null);
});

check('a forced fight arms both villagers with swords and then scores it', () => {
  const { social, npcs, applied } = makeSocial();
  const result = social.startFight(npcs[0], npcs[1], { forced: true });
  assert.equal(result.ok, true);
  assert.equal(npcs[0].heldItem, 'sword');
  assert.equal(npcs[1].heldItem, 'sword');
  assert.equal(npcs[0].sim.fighting, true);

  for (let i = 0; i < 60 && social.status().fighting; i += 1) social.update(0.25);

  assert.equal(social.status().fighting, false);
  assert.equal(npcs[0].sim.fighting, false);
  assert.equal(npcs[0].heldItem, null);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].options.disagreement, true);
});

check('an argument between enemies escalates into a fight', () => {
  const { social, npcs } = makeSocial();
  const socialHostile = createSocial({
    relationships: {
      category: () => 'enemy',
      applyConversation: () => {},
    },
    getNpcs: () => npcs,
    lifestyle: {
      pose: (a, b) => {
        a.sim.state = 'talking';
        b.sim.state = 'talking';
      },
      handBack: (npc) => { npc.sim.state = 'walking'; },
    },
    conversations: { abandon: () => {} },
    rng: () => 0.25,
  });
  assert.equal(socialHostile.escalate({
    outcome: 'complete', mood: 'tense', closeReason: 'argument', npcA: npcs[0], npcB: npcs[1],
  }), true);
  assert.equal(socialHostile.status().fighting, true);
  socialHostile.stopAll();
  social.stopAll();
});

check('punish and pet answer with a preset line', () => {
  const { social, npcs } = makeSocial();
  const punished = social.punish(npcs[0]);
  assert.ok(PUNISH_LINES.includes(punished.line));
  assert.equal(npcs[0].sim.dialogue, punished.line);
  const petted = social.pet(npcs[1]);
  assert.ok(PET_LINES.includes(petted.line));
  assert.equal(npcs[1].sim.react, 'pet');
});

check('a scripted conversation plays its own lines and finishes', () => {
  const { social, npcs, applied } = makeSocial();
  const result = social.playScript(npcs[0], npcs[1], 'Ada: Hello.\nBo: Hi.\nAda: Bye.');
  assert.equal(result.ok, true);
  assert.equal(result.lines, 3);
  for (let i = 0; i < 80 && social.status().scripting; i += 1) social.update(0.25);
  assert.equal(social.status().scripting, false);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].session.messages.length, 3);
});

console.log(`\n${passed} checks passed`);
