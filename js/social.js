// Player interactions, fights and scripted conversations.
//
// Three things live here, all of them deliberately outside the model:
//   * preset reactions to a left click (punish) and a right click (pet), each with
//     an animated expression icon from the pack
//   * fights, which start between villagers who genuinely dislike each other, or
//     when the debug panel forces one so it can be watched
//   * scripted conversations typed into the debug panel
//
// A fight runs on hidden hit points. When one side is badly hurt they break and run;
// the other gives chase, a little faster, until the loser is knocked out and left
// dazed on the ground for a while. The relationship records pay for all of it.

import { findPath } from './pathing.js';

export const PUNISH_LINES = [
  'Sorry, Master.',
  'Yes, Master. It will not happen again.',
  'I am sorry, Master. I was wrong.',
  'Forgive me, Master.',
  'Sorry, Master. I will do better.',
  'You are right, Master. Sorry.',
  'I hear you, Master.',
  'Sorry, Master. Please do not be angry.',
  'Yes, Master. I understand.',
  'Sorry. I did not mean to upset you, Master.',
  'It was my fault, Master.',
  'I will fix it, Master. Sorry.',
  'Sorry, Master. I should have listened.',
  'Master, I am sorry.',
  'I know. Sorry, Master.',
  'Yes, Master. Right away.',
  'Sorry, Master. I will be more careful.',
  'I was careless, Master. Sorry.',
  'Forgive me. I will do as you say, Master.',
  'Sorry, Master. I will keep out of your way.',
];

export const LEARNED_PUNISH_LINES = [
  'Sorry, Master. I will not bring that up again.',
  'I understand, Master. That subject is off the table.',
  'I hear you, Master. I will leave that alone.',
  'Sorry, Master. I will keep to other things.',
  'Yes, Master. I have learned my lesson.',
];

export const PET_LINES = [
  'That is lovely.',
  'Oh, I like that.',
  'Again, please.',
  'That made my day.',
  'You are kind.',
  'I feel warm inside.',
  'This is nice.',
  'I needed that.',
  'Thank you. That was sweet.',
  'You always know how to cheer me up.',
  'I could stay here all day.',
  'That tickles.',
  'Happy to see you too.',
  'What a lovely moment.',
  'I feel much better now.',
  'You have a gentle hand.',
  'That was just what I needed.',
  'I will remember this.',
  'My day just got better.',
  'Come back and do that again.',
];

export const LEARNED_REWARD_LINES = [
  'I am glad you liked that. I will keep it up.',
  'That is good to know. I will remember that.',
  'You liked that? I will do it more.',
  'Thank you. I will keep that habit.',
  'I am pleased I did the right thing.',
];

export const FIGHT_LINES = [
  'You started this.',
  'Keep your hands to yourself.',
  'I have had enough of you.',
  'Say that again.',
  'You never listen.',
  'Back off.',
  'Do not push me.',
  'That was uncalled for.',
  'I am warning you.',
  'You think you are clever?',
  'Not another word.',
  'You asked for this.',
  'Stay out of my way.',
  'I am done being polite.',
  'You will regret that.',
  'Enough.',
];

export const FLEE_LINES = [
  'That is enough!',
  'I am leaving.',
  'Do not come closer.',
  'You are mad.',
  'Get away from me.',
  'I am done with this.',
];

export const KO_LINES = [
  'Stay down.',
  'Had enough?',
  'Do not get up.',
  'That is the end of it.',
  'And stay there.',
];

const ARGUMENT_LINES = [
  { speaker: 0, text: 'You have been impossible all day.' },
  { speaker: 1, text: 'Then stop talking to me.' },
  { speaker: 0, text: 'Gladly. You never listen anyway.' },
  { speaker: 1, text: 'Say that to my face.' },
];

const HOSTILE = new Set(['disliked', 'enemy']);
const MAX_SCRIPT_LINES = 30;
const MAX_HP = 100;
const FLEE_HP = 30;
const STUN_MS = 6000;
const FIGHT_LIMIT = 18;

const pick = (rng, list) => list[Math.floor(rng() * list.length) % list.length];

// `Name: line` is the documented format, but a script that does not name a speaker
// simply alternates between the two villagers. Unknown prefixes are left in the line
// so a colon in ordinary dialogue is never eaten.
export function parseScript(text, a, b) {
  const lines = [];
  const nameA = a && a.name ? String(a.name).trim().toLowerCase() : null;
  const nameB = b && b.name ? String(b.name).trim().toLowerCase() : null;

  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    let body = line;
    let speaker = null;
    const match = line.match(/^([^:]{1,24}):\s*(.+)$/);
    if (match) {
      const name = match[1].trim().toLowerCase();
      if (a && (name === nameA || name === 'a')) speaker = a;
      else if (b && (name === nameB || name === 'b')) speaker = b;
      if (speaker) body = match[2].trim();
    }
    if (!body) continue;
    if (!speaker) speaker = lines.length % 2 === 0 ? a : b;
    lines.push({
      speakerId: speaker && speaker.config ? speaker.config.id : null,
      text: body.slice(0, 170),
    });
    if (lines.length >= MAX_SCRIPT_LINES) break;
  }
  return lines;
}

function transcript(a, b, entries) {
  return entries.map((entry, index) => {
    const speaker = entry.speaker === b || entry.speakerId === (b.config && b.config.id) ? b : a;
    return {
      speakerId: speaker.config ? speaker.config.id : null,
      speakerName: speaker.name,
      text: entry.text,
      number: index + 1,
    };
  });
}

export function createSocial({
  relationships,
  getNpcs = () => [],
  lifestyle,
  conversations = null,
  rng = Math.random,
  now = () => Date.now(),
} = {}) {
  let fight = null;
  let script = null;
  let stun = null;
  const sayTokens = new Map();

  const simOf = (npc) => (npc && npc.sim ? npc.sim : null);

  function say(npc, text, ms = 5000) {
    const sim = simOf(npc);
    if (!sim) return;
    sim.dialogue = text;
    const token = Symbol('line');
    sayTokens.set(npc, token);
    const timer = setTimeout(() => {
      if (sayTokens.get(npc) === token && sim.dialogue === text) sim.dialogue = null;
    }, ms);
    // never hold a headless test process open for a line of dialogue
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function clearSay(npc) {
    const sim = simOf(npc);
    sayTokens.delete(npc);
    if (sim) sim.dialogue = null;
  }

  function emote(npc, id, ms = 2600) {
    const sim = simOf(npc);
    if (!sim) return;
    sim.emote = id;
    sim.emoteAt = now();
    sim.emoteUntil = now() + ms;
  }

  function clearEmote(npc) {
    const sim = simOf(npc);
    if (!sim) return;
    sim.emote = null;
    sim.emoteUntil = 0;
  }

  function abandon(npc) {
    const sim = simOf(npc);
    if (sim && sim.session && conversations) conversations.abandon(sim.session, 'social');
  }

  function hostile(a, b) {
    if (!relationships || !a || !b || !a.config || !b.config) return false;
    return HOSTILE.has(relationships.category(a.config.id, b.config.id))
      || HOSTILE.has(relationships.category(b.config.id, a.config.id));
  }

  function canFight(a, b) {
    if (!a || !b || a === b) return false;
    if (a.room || b.room) return false;
    const sa = simOf(a);
    const sb = simOf(b);
    if ((sa && sa.state === 'sleeping') || (sb && sb.state === 'sleeping')) return false;
    return hostile(a, b);
  }

  function punish(npc) {
    if (!npc) return null;
    // A punishment during a talk teaches the subject, not just the animation. Outside
    // a conversation there is no subject to learn, so the ordinary reaction remains.
    const learned = conversations && typeof conversations.react === 'function'
      ? conversations.react(npc, 'punish')
      : null;
    const line = pick(rng, learned ? LEARNED_PUNISH_LINES : PUNISH_LINES);
    const sim = simOf(npc);
    if (sim) {
      sim.react = 'punish';
      sim.reactUntil = now() + 1600;
    }
    emote(npc, 'stress', 2400);
    say(npc, line, 4600);
    return { line, learned };
  }

  function pet(npc) {
    if (!npc) return null;
    const learned = conversations && typeof conversations.react === 'function'
      ? conversations.react(npc, 'reward')
      : null;
    const line = pick(rng, learned ? LEARNED_REWARD_LINES : PET_LINES);
    const sim = simOf(npc);
    if (sim) {
      sim.react = 'pet';
      sim.reactUntil = now() + 1600;
    }
    emote(npc, 'love', 2800);
    say(npc, line, 4600);
    return { line, learned };
  }

  function pose(a, b) {
    abandon(a);
    abandon(b);
    if (lifestyle && lifestyle.pose) lifestyle.pose(a, b);
  }

  function releaseFighter(npc, f) {
    const sim = simOf(npc);
    if (sim) {
      sim.fighting = false;
      sim.react = null;
    }
    if (f && f.speeds.has(npc)) npc.speed = f.speeds.get(npc);
    npc.heldItem = f && f.items.has(npc) ? f.items.get(npc) : null;
    npc.path = [];
    npc.moving = false;
    npc.waitTime = 0.2;
  }

  function scoreFight(f) {
    if (!relationships) return;
    const messages = transcript(f.a, f.b, FIGHT_LINES.slice(0, 4).map((text, index) => ({
      speaker: index % 2 === 0 ? f.a : f.b,
      text,
    })));
    relationships.applyConversation({
      participants: [
        { id: f.a.config.id, name: f.a.name },
        { id: f.b.config.id, name: f.b.name },
      ],
      messages,
      mood: 'tense',
    }, { disagreement: true });
  }

  function stopFight({ scored = false } = {}) {
    if (!fight) return false;
    const f = fight;
    fight = null;
    for (const npc of [f.a, f.b]) releaseFighter(npc, f);
    if (scored) scoreFight(f);
    if (lifestyle) {
      lifestyle.handBack(f.a);
      lifestyle.handBack(f.b);
    }
    return true;
  }

  function clearStun() {
    if (!stun) return;
    const npc = stun.npc;
    stun = null;
    const sim = simOf(npc);
    if (sim) {
      sim.stunned = false;
      sim.stunnedUntil = 0;
    }
    clearEmote(npc);
    if (lifestyle) lifestyle.handBack(npc);
  }

  function startFight(a, b, { forced = false } = {}) {
    if (fight) stopFight();
    clearStun();
    if (!a || !b || a === b) return { ok: false, reason: 'Pick two different villagers.' };
    if (a.room || b.room) return { ok: false, reason: 'They need to be outside to fight.' };
    const sa = simOf(a);
    const sb = simOf(b);
    if ((sa && sa.state === 'sleeping') || (sb && sb.state === 'sleeping')) {
      return { ok: false, reason: 'They are asleep.' };
    }
    if (!forced && !hostile(a, b)) {
      return { ok: false, reason: 'They do not dislike each other enough to fight.' };
    }

    const items = new Map([[a, a.heldItem || null], [b, b.heldItem || null]]);
    const speeds = new Map([[a, a.speed], [b, b.speed]]);
    pose(a, b);
    a.heldItem = 'sword';
    b.heldItem = 'sword';
    if (sa) { sa.fighting = true; sa.react = null; }
    if (sb) { sb.fighting = true; sb.react = null; }

    fight = {
      a,
      b,
      items,
      speeds,
      hp: new Map([[a, MAX_HP], [b, MAX_HP]]),
      elapsed: 0,
      duration: FIGHT_LIMIT,
      attackAt: 0.9,
      nextLine: 0.35,
      lineIndex: 0,
      turn: 0,
      phase: 'approach',
      fleeing: null,
      chaser: null,
      nextApproach: 0,
      nextFlee: 0,
      nextChase: 0,
      forced,
    };

    // Both fighters are free to move from here; pose() left them planted.
    for (const npc of [a, b]) npc.waitTime = 0;
    const gap = Math.hypot(a.x - b.x, a.y - b.y);
    if (gap <= 26) squareUp(fight);
    return { ok: true, fight };
  }

  // Walk both fighters at each other until they are close enough to square up. A
  // debug fight can start with the pair on opposite sides of the village, so damage
  // must never begin until they have actually closed the distance.
  function approachStep(f) {
    const { a, b } = f;
    const gap = Math.hypot(b.x - a.x, b.y - a.y);
    if (gap <= 26) {
      squareUp(f);
      return;
    }
    a.facing = b.x >= a.x ? 1 : -1;
    b.facing = -a.facing;
    if (f.elapsed >= f.nextApproach) {
      stepToward(a, b);
      stepToward(b, a);
      f.nextApproach = f.elapsed + 0.45;
    }
  }

  function stepToward(npc, other) {
    if (!npc.village) return false;
    const path = findPath(npc.village, npc.tile, other.tile, { avoid: npc.village.doorways });
    if (path && path.length) {
      npc.path = path;
      npc.waitTime = 0;
      npc.moving = true;
      return true;
    }
    return false;
  }

  // Stop the walk, turn them into each other and let the pixel-level stance finish
  // the approach. Normal fights start about a body-length apart.
  function squareUp(f) {
    f.phase = 'brawl';
    for (const [npc, other] of [[f.a, f.b], [f.b, f.a]]) {
      npc.path = [];
      npc.moving = false;
      npc.waitTime = 0;
      npc.facing = other.x >= npc.x ? 1 : -1;
    }
    f.attackAt = Math.max(f.attackAt, f.elapsed + 0.35);
  }

  function moveFighter(npc, dx, dy) {
    if (!npc.village) {
      npc.x += dx;
      npc.y += dy;
      return;
    }
    if (npc.village.feetBlockedAt && npc.village.feetBlockedAt(npc.x + dx, npc.y + dy)) return;
    npc.x += dx;
    npc.y += dy;
  }

  // Close the last few pixels smoothly instead of teleporting: both fighters step in,
  // bodies end up all but touching, and the next sword thrust crosses the gap.
  function squareUpStep(f, dt) {
    const { a, b } = f;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const gap = Math.hypot(dx, dy);
    if (gap > 14 && gap > 0.01) {
      const ux = dx / gap;
      const uy = dy / gap;
      const move = Math.min(gap - 14, 26 * dt) / 2;
      if (move > 0.01) {
        moveFighter(a, ux * move, uy * move);
        moveFighter(b, -ux * move, -uy * move);
        a.moving = true;
        b.moving = true;
      }
    } else {
      a.moving = false;
      b.moving = false;
    }
    a.facing = b.x >= a.x ? 1 : -1;
    b.facing = -a.facing;
  }

  // A route to open ground as far from the attacker as possible, staying in the same
  // walkable region so nobody flees across a river to escape a fight.
  function fleePath(npc, threat) {
    if (!npc || !npc.village || !npc.tile) return null;
    const village = npc.village;
    const tile = npc.tile;
    const T = village.tileSize || 16;
    let best = null;
    let bestGap = -1;
    for (let attempt = 0; attempt < 26; attempt += 1) {
      const dx = Math.round((rng() * 2 - 1) * 12);
      const dy = Math.round((rng() * 2 - 1) * 12);
      if (Math.hypot(dx, dy) < 5) continue;
      const goal = { x: tile.x + dx, y: tile.y + dy };
      if (goal.x < 0 || goal.y < 0 || goal.x >= village.cols || goal.y >= village.rows) continue;
      if (village.blockedValue(goal.x, goal.y) !== 0) continue;
      if (village.isDoorway && village.isDoorway(goal.x, goal.y)) continue;
      if (village.region && npc.regionId !== undefined && npc.regionId !== null
        && village.region[goal.y * village.cols + goal.x] !== npc.regionId) continue;
      const path = findPath(village, tile, goal, { avoid: village.doorways });
      if (!path || !path.length) continue;
      const gap = Math.hypot(goal.x * T + T / 2 - threat.x, goal.y * T + T / 2 - threat.y);
      if (gap > bestGap) {
        bestGap = gap;
        best = path;
      }
    }
    return best;
  }

  function beginChase(f, victim) {
    const chaser = victim === f.a ? f.b : f.a;
    f.phase = 'chase';
    f.fleeing = victim;
    f.chaser = chaser;
    // The runaway gets a small head start; the pursuer is a little faster so the
    // chase closes instead of running forever.
    victim.speed = Math.max(18, victim.speed * 0.88);
    chaser.speed = victim.speed * 1.16;
    victim.path = [];
    victim.waitTime = 0;
    chaser.path = [];
    chaser.waitTime = 0;
    // Start running immediately: a fight begins within speaking distance, so waiting
    // for the gap to grow would leave the loser standing still while being hit.
    const escape = fleePath(victim, chaser);
    if (escape) {
      victim.path = escape;
      victim.moving = true;
    }
    emote(victim, 'alerted', 2600);
    say(victim, pick(rng, FLEE_LINES), 2400);
    f.nextFlee = 0;
    f.nextChase = 0;
    f.attackAt = f.elapsed + 0.5;
  }

  function chaseStep(f) {
    const victim = f.fleeing;
    const chaser = f.chaser;
    if (!victim || !chaser) return;
    const gap = Math.hypot(victim.x - chaser.x, victim.y - chaser.y);

    if ((!victim.path.length || f.elapsed >= f.nextFlee) && gap > 18) {
      const path = fleePath(victim, chaser);
      if (path) {
        victim.path = path;
        victim.waitTime = 0;
        victim.moving = true;
      }
      f.nextFlee = f.elapsed + 1.4;
    }

    if (!chaser.village || !victim.village) return;
    if (!chaser.path.length || f.elapsed >= f.nextChase) {
      const path = findPath(chaser.village, chaser.tile, victim.tile, { avoid: chaser.village.doorways });
      if (path && path.length) {
        chaser.path = path;
        chaser.waitTime = 0;
        chaser.moving = true;
      }
      f.nextChase = f.elapsed + 0.45;
    }
  }

  function knockout(f, loser, winner) {
    fight = null;
    for (const npc of [f.a, f.b]) releaseFighter(npc, f);
    scoreFight(f);
    if (lifestyle) lifestyle.handBack(winner);

    const sim = simOf(loser);
    if (sim) {
      sim.stunned = true;
      sim.stunnedUntil = now() + STUN_MS;
      sim.dialogue = null;
      loser.path = [];
      loser.moving = false;
      loser.waitTime = 1e9;
      loser.facing = winner.x >= loser.x ? 1 : -1;
      emote(loser, 'dizzy', STUN_MS);
    }
    say(winner, pick(rng, KO_LINES), 3000);
    stun = { npc: loser, until: (sim && sim.stunnedUntil) || now() + STUN_MS };
  }

  function playScript(a, b, source, { fightAfter = false } = {}) {
    stopAll();
    if (!a || !b || a === b) return { ok: false, reason: 'Pick two different villagers.' };
    const lines = Array.isArray(source) ? source : parseScript(source, a, b);
    if (!lines.length) return { ok: false, reason: 'Write at least one line.' };

    pose(a, b);
    script = {
      a,
      b,
      lines,
      spoken: [],
      index: 0,
      elapsed: 0,
      nextAt: 0,
      endAt: null,
      fightAfter,
    };
    return { ok: true, lines: lines.length };
  }

  function finishScript() {
    if (!script) return;
    const { a, b, spoken, fightAfter } = script;
    script = null;
    if (relationships && spoken.length) {
      relationships.applyConversation({
        participants: [
          { id: a.config.id, name: a.name },
          { id: b.config.id, name: b.name },
        ],
        messages: transcript(a, b, spoken),
        mood: 'calm',
      }, {});
    }
    if (lifestyle) {
      lifestyle.handBack(a);
      lifestyle.handBack(b);
    }
    if (fightAfter) {
      startFight(a, b, { forced: true });
    } else {
      say(a, 'That was a good talk.', 2600);
    }
  }

  // A forced argument for the debug panel: a short row, then a fight so the swords
  // and the chase can actually be watched.
  function argue(a, b) {
    const lines = ARGUMENT_LINES.map((entry) => ({
      speakerId: entry.speaker === 0
        ? (a && a.config ? a.config.id : null)
        : (b && b.config ? b.config.id : null),
      text: entry.text,
    }));
    return playScript(a, b, lines, { fightAfter: true });
  }

  // A real conversation that ended in a row only turns into a fight if the pair
  // already dislikes each other. Friends can argue and make up without drawing steel.
  function escalate(session) {
    if (!session || session.outcome !== 'complete') return false;
    // A group row is not a duel; only a two-person argument can turn into a fight.
    if (session.participants && session.participants.length > 2) return false;
    if (fight || script || stun) return false;
    const argued = session.closeReason === 'argument';
    const boiling = session.mood === 'tense' && rng() < 0.45;
    if (!argued && !boiling) return false;
    if (!canFight(session.npcA, session.npcB)) return false;
    return startFight(session.npcA, session.npcB).ok;
  }

  function stopAll() {
    if (fight) stopFight();
    if (stun) clearStun();
    if (script) {
      const { a, b } = script;
      script = null;
      if (lifestyle) {
        lifestyle.handBack(a);
        lifestyle.handBack(b);
      }
    }
  }

  function update(dt) {
    const step = Math.min(0.5, Math.max(0, dt));

    for (const npc of getNpcs()) {
      const sim = simOf(npc);
      if (!sim) continue;
      if (sim.react && sim.reactUntil && now() >= sim.reactUntil) {
        sim.react = null;
        sim.reactUntil = 0;
      }
      if (sim.emote && sim.emoteUntil && now() > sim.emoteUntil && !sim.stunned) {
        sim.emote = null;
        sim.emoteUntil = 0;
      }
    }

    if (stun && now() >= stun.until) clearStun();

    if (script) {
      script.elapsed += step;
      if (script.index < script.lines.length && script.elapsed >= script.nextAt) {
        const entry = script.lines[script.index];
        script.index += 1;
        const speaker = entry.speakerId === (script.b.config && script.b.config.id) ? script.b : script.a;
        const other = speaker === script.a ? script.b : script.a;
        clearSay(other);
        say(speaker, entry.text, 4200);
        script.spoken.push({
          speakerId: entry.speakerId,
          text: entry.text,
        });
        script.nextAt = script.elapsed + Math.min(4.2, 1.5 + entry.text.length / 38);
        if (script.index >= script.lines.length) script.endAt = script.nextAt + 0.7;
      }
      if (script && script.endAt !== null && script.elapsed >= script.endAt) finishScript();
    }

    if (fight) {
      const f = fight;
      f.elapsed += step;
      if (f.phase === 'approach') approachStep(f);
      else if (f.phase === 'chase') chaseStep(f);
      else squareUpStep(f, step);

      if (f.elapsed >= f.nextLine) {
        const speaker = f.lineIndex % 2 === 0 ? f.a : f.b;
        const other = speaker === f.a ? f.b : f.a;
        clearSay(other);
        say(speaker, FIGHT_LINES[f.lineIndex % FIGHT_LINES.length], 2200);
        f.lineIndex += 1;
        f.nextLine = f.elapsed + 0.8 + rng() * 0.4;
      }

      // Contact is required to hurt anyone: no invisible punches across the village.
      const gap = Math.hypot(f.a.x - f.b.x, f.a.y - f.b.y);
      const reach = f.phase === 'chase' ? 26 : 24;
      if (f.elapsed >= f.attackAt && gap <= reach) {
        const attacker = f.phase === 'chase'
          ? f.chaser
          : (f.turn % 2 === 0 ? f.a : f.b);
        const defender = attacker === f.a ? f.b : f.a;
        const damage = 8 + Math.floor(rng() * 8);
        const hp = Math.max(0, (f.hp.get(defender) ?? MAX_HP) - damage);
        f.hp.set(defender, hp);
        f.turn += 1;
        f.attackAt = f.elapsed + 0.55 + rng() * 0.35;

        const attackerSim = simOf(attacker);
        if (attackerSim) attackerSim.attackUntil = now() + 320;
        const defenderSim = simOf(defender);
        if (defenderSim) defenderSim.hurtUntil = now() + 240;
        emote(defender, 'stress', 1000);

        if (hp <= 0) {
          knockout(f, defender, attacker);
          return;
        }
        if (hp <= FLEE_HP && f.phase === 'brawl') beginChase(f, defender);
      }

      if (fight && fight.elapsed >= fight.duration) stopFight({ scored: true });
    }
  }

  function status() {
    return {
      fighting: !!fight,
      fighters: fight ? [fight.a.name, fight.b.name] : [],
      fightElapsed: fight ? Number(fight.elapsed.toFixed(1)) : 0,
      phase: fight ? fight.phase : null,
      hp: fight ? [fight.hp.get(fight.a), fight.hp.get(fight.b)] : [],
      fleeing: fight && fight.fleeing ? fight.fleeing.name : null,
      stunned: !!stun,
      stunnedName: stun ? stun.npc.name : null,
      scripting: !!script,
      scriptIndex: script ? script.index : 0,
      scriptLines: script ? script.lines.length : 0,
      scriptPair: script ? [script.a.name, script.b.name] : [],
    };
  }

  return {
    punish,
    pet,
    startFight,
    stopFight,
    playScript,
    argue,
    escalate,
    stopAll,
    update,
    status,
    canFight,
    hostile,
  };
}
