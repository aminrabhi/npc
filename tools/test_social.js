// Headless checks for the preset reactions, script parser and fight lifecycle.
//
// The village itself needs a canvas, but none of this does: the line banks are
// plain arrays, the parser is pure, and the fight manager only needs villager-shaped
// objects and a stubbed relationship store.

import assert from 'node:assert/strict';
import {
  PUNISH_LINES,
  PET_LINES,
  LEARNED_PUNISH_LINES,
  LEARNED_REWARD_LINES,
  FIGHT_LINES,
  parseScript,
  createSocial,
} from '../js/social.js';
import { NPC } from '../js/npc.js';

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

const learnedBanks = { punished: LEARNED_PUNISH_LINES, rewarded: LEARNED_REWARD_LINES };
for (const [name, bank] of Object.entries(learnedBanks)) {
  check(`${name} line bank has enough responses`, () => {
    assert.ok(bank.length >= 4, `${name} bank only has ${bank.length} lines`);
    assert.equal(new Set(bank).size, bank.length, `${name} bank repeats a line`);
    assert.ok(bank.every((line) => line.length <= 90), `${name} has a line that is too long`);
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

function makeVillage() {
  return {
    tileSize: 16,
    cols: 40,
    rows: 40,
    region: null,
    doorways: new Set(),
    blockedValue: () => 0,
    isSolid: () => false,
    isWalkable: () => true,
  };
}

function makeNpc(id, name, x = 160) {
  return {
    name,
    config: { id },
    sim: { state: 'walking', dialogue: null, session: null, partner: null },
    heldItem: null,
    room: null,
    village: makeVillage(),
    x,
    y: 160,
    speed: 26,
    path: [],
    waitTime: 0,
    moving: false,
    get tile() {
      return { x: Math.floor(this.x / 16), y: Math.floor(this.y / 16) };
    },
  };
}

function makeSocial(overrides = {}) {
  const npcs = [makeNpc('npc_1', 'Ada', 160), makeNpc('npc_2', 'Bo', 176)];
  const applied = [];
  let clock = 1000;
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
    now: () => clock,
    ...overrides,
  });
  return {
    social,
    npcs,
    applied,
    advance: (ms) => { clock += ms; },
  };
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

  let sawChase = false;
  let sawDamage = false;
  for (let i = 0; i < 120 && social.status().fighting; i += 1) {
    social.update(0.2);
    const state = social.status();
    if (state.phase === 'chase') sawChase = true;
    if (state.hp.some((hp) => hp < 100)) sawDamage = true;
  }

  const state = social.status();
  assert.equal(state.fighting, false);
  assert.equal(state.stunned, true);
  assert.equal(sawChase, true);
  assert.equal(sawDamage, true);
  assert.equal(npcs.some((npc) => npc.sim.stunned === true), true);
  assert.equal(npcs[0].sim.fighting, false);
  assert.equal(npcs[0].heldItem, null);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].options.disagreement, true);
});

check('a fighter does not fall back to idle planning between blows', () => {
  let planned = false;
  let walked = false;
  let idled = false;
  const fighter = {
    moving: true,
    sim: { fighting: true },
    get atHome() { return false; },
    onPlan: () => { planned = true; },
    walkHome: () => { walked = true; return true; },
    idle: () => { idled = true; },
  };
  NPC.prototype.settle.call(fighter);
  assert.equal(planned, false);
  assert.equal(walked, false);
  assert.equal(idled, false);

  fighter.sim.fighting = false;
  fighter.sim.scripting = true;
  NPC.prototype.settle.call(fighter);
  assert.equal(planned, false);

  fighter.sim.scripting = false;
  NPC.prototype.settle.call(fighter);
  assert.equal(planned, true);
});

check('a fight deals no damage until the pair have closed the distance', () => {
  const { social, npcs } = makeSocial();
  npcs[1].x = 320; // across the village
  const result = social.startFight(npcs[0], npcs[1], { forced: true });
  assert.equal(result.ok, true);

  for (let i = 0; i < 20; i += 1) social.update(0.2);
  assert.equal(social.status().phase, 'approach');
  assert.deepEqual(social.status().hp, [100, 100]);

  // What NPC movement does in the village: once they are close, the fight squares up
  // and only then can a sword land.
  npcs[1].x = npcs[0].x + 20;
  social.update(0.2);
  assert.equal(social.status().phase, 'brawl');
  for (let i = 0; i < 15; i += 1) social.update(0.2);
  const hp = social.status().hp;
  assert.ok(hp[0] < 100 || hp[1] < 100, `no damage was dealt at contact: ${hp}`);
  social.stopAll();
});

check('a knocked-out villager recovers after the stun', () => {
  const { social, npcs, advance } = makeSocial();
  social.startFight(npcs[0], npcs[1], { forced: true });
  for (let i = 0; i < 120 && social.status().fighting; i += 1) social.update(0.2);
  assert.equal(social.status().stunned, true);

  advance(6100);
  social.update(0.1);
  assert.equal(social.status().stunned, false);
  assert.equal(npcs.some((npc) => npc.sim.stunned === true), false);
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
  assert.equal(npcs[0].sim.emote, 'stress');
  const petted = social.pet(npcs[1]);
  assert.ok(PET_LINES.includes(petted.line));
  assert.equal(npcs[1].sim.react, 'pet');
  assert.equal(npcs[1].sim.emote, 'love');
});

check('punishing a current subject teaches the villager to drop it', () => {
  const calls = [];
  const { social, npcs } = makeSocial({
    conversations: {
      abandon: () => {},
      react: (npc, kind) => {
        calls.push({ npcId: npc.config.id, kind });
        return { kind: 'avoid', topic: 'a bet you lost' };
      },
    },
  });
  const result = social.punish(npcs[0]);
  assert.deepEqual(calls, [{ npcId: 'npc_1', kind: 'punish' }]);
  assert.ok(LEARNED_PUNISH_LINES.includes(result.line));
  assert.equal(result.learned.topic, 'a bet you lost');
  assert.equal(result.learned.kind, 'avoid');
});

check('rewarding a current subject records a good habit', () => {
  const calls = [];
  const { social, npcs } = makeSocial({
    conversations: {
      abandon: () => {},
      react: (npc, kind) => {
        calls.push({ npcId: npc.config.id, kind });
        return { kind: 'good', topic: 'the sea' };
      },
    },
  });
  const result = social.pet(npcs[1]);
  assert.deepEqual(calls, [{ npcId: 'npc_2', kind: 'reward' }]);
  assert.ok(LEARNED_REWARD_LINES.includes(result.line));
  assert.equal(result.learned.topic, 'the sea');
  assert.equal(result.learned.kind, 'good');
});

check('a scripted conversation plays its own lines and finishes', () => {
  const { social, npcs, applied } = makeSocial();
  const result = social.playScript(npcs[0], npcs[1], 'Ada: Hello.\nBo: Hi.\nAda: Bye.');
  assert.equal(result.ok, true);
  assert.equal(result.lines, 3);
  assert.equal(result.walking, false);
  assert.equal(social.status().scriptPhase, 'lines');
  for (let i = 0; i < 80 && social.status().scripting; i += 1) social.update(0.25);
  assert.equal(social.status().scripting, false);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].session.messages.length, 3);
});

check('a scripted conversation walks the pair together before speaking', () => {
  const { social, npcs, applied } = makeSocial();
  npcs[1].x = 320; // across the village, well outside speaking distance
  const result = social.playScript(npcs[0], npcs[1], 'Ada: Hello.\nBo: Hi.');
  assert.equal(result.ok, true);
  assert.equal(result.walking, true);
  assert.equal(social.status().scriptPhase, 'approach');
  assert.ok(npcs[0].path.length > 0, 'the first villager has no route to the meeting point');
  assert.ok(npcs[1].path.length > 0, 'the second villager has no route to the meeting point');
  assert.equal(npcs[0].sim.dialogue, null);

  // NPC.update normally moves the bodies; stand them close here to prove the script
  // refuses to speak until they have arrived.
  social.update(0.25);
  assert.equal(social.status().scriptPhase, 'approach');
  assert.equal(social.status().scriptIndex, 0);
  npcs[1].x = npcs[0].x + 20;
  social.update(0.25);
  assert.equal(social.status().scriptPhase, 'lines');

  for (let i = 0; i < 80 && social.status().scripting; i += 1) social.update(0.25);
  assert.equal(social.status().scripting, false);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].session.messages.length, 2);
});

console.log(`\n${passed} checks passed`);
