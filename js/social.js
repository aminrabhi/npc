// Player interactions, fights and scripted conversations.
//
// Three things live here, all of them deliberately outside the model:
//   * preset reactions to a left click (punish) and a right click (pet)
//   * fights, which only start between villagers who genuinely dislike each other,
//     or when the debug panel forces one so it can be watched
//   * scripted conversations typed into the debug panel
//
// A fight is a conversation in spirit: both villagers hold a sword, trade preset
// lines, and the relationship records pay for it when it ends. Nothing here calls
// Groq or Supabase directly; the relationships module already owns persistence.

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

const ARGUMENT_LINES = [
  { speaker: 0, text: 'You have been impossible all day.' },
  { speaker: 1, text: 'Then stop talking to me.' },
  { speaker: 0, text: 'Gladly. You never listen anyway.' },
  { speaker: 1, text: 'Say that to my face.' },
];

const HOSTILE = new Set(['disliked', 'enemy']);
const MAX_SCRIPT_LINES = 30;

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
    const line = pick(rng, PUNISH_LINES);
    const sim = simOf(npc);
    if (sim) {
      sim.react = 'punish';
      sim.reactUntil = now() + 1600;
    }
    say(npc, line, 4600);
    return { line };
  }

  function pet(npc) {
    if (!npc) return null;
    const line = pick(rng, PET_LINES);
    const sim = simOf(npc);
    if (sim) {
      sim.react = 'pet';
      sim.reactUntil = now() + 1600;
    }
    say(npc, line, 4600);
    return { line };
  }

  function pose(a, b) {
    abandon(a);
    abandon(b);
    if (lifestyle && lifestyle.pose) lifestyle.pose(a, b);
  }

  function startFight(a, b, { forced = false } = {}) {
    if (fight) stopFight();
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

    const restore = [a.heldItem || null, b.heldItem || null];
    pose(a, b);
    a.heldItem = 'sword';
    b.heldItem = 'sword';
    if (sa) { sa.fighting = true; sa.react = null; }
    if (sb) { sb.fighting = true; sb.react = null; }

    fight = {
      a,
      b,
      restore,
      elapsed: 0,
      duration: 6.5 + rng() * 2.5,
      nextLine: 0.35,
      lineIndex: 0,
      forced,
    };
    return { ok: true, fight };
  }

  function stopFight({ scored = false } = {}) {
    if (!fight) return false;
    const { a, b, restore } = fight;
    const elapsed = fight.elapsed;
    fight = null;

    for (const [npc, item] of [[a, restore[0]], [b, restore[1]]]) {
      const sim = simOf(npc);
      if (sim) {
        sim.fighting = false;
        sim.react = null;
      }
      npc.heldItem = item;
    }

    if (scored && relationships && elapsed > 1) {
      const messages = transcript(a, b, FIGHT_LINES.slice(0, 4).map((text, index) => ({
        speaker: index % 2 === 0 ? a : b,
        text,
      })));
      relationships.applyConversation({
        participants: [
          { id: a.config.id, name: a.name },
          { id: b.config.id, name: b.name },
        ],
        messages,
        mood: 'tense',
      }, { disagreement: true });
    }

    if (lifestyle) {
      lifestyle.handBack(a);
      lifestyle.handBack(b);
    }
    if (scored) say(a, 'We are done here.', 3200);
    return true;
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
  // and swings can actually be watched.
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
    if (fight || script) return false;
    // A proper row always counts; a merely tense chat between enemies has a good
    // chance of boiling over as well, so bad blood eventually shows.
    const argued = session.closeReason === 'argument';
    const boiling = session.mood === 'tense' && rng() < 0.45;
    if (!argued && !boiling) return false;
    if (!canFight(session.npcA, session.npcB)) return false;
    return startFight(session.npcA, session.npcB).ok;
  }

  function stopAll() {
    if (fight) stopFight();
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
      if (sim && sim.react && sim.reactUntil && now() >= sim.reactUntil) {
        sim.react = null;
        sim.reactUntil = 0;
      }
    }

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
      fight.elapsed += step;
      if (fight.elapsed >= fight.nextLine) {
        const speaker = fight.lineIndex % 2 === 0 ? fight.a : fight.b;
        const other = speaker === fight.a ? fight.b : fight.a;
        clearSay(other);
        say(speaker, FIGHT_LINES[fight.lineIndex % FIGHT_LINES.length], 2600);
        fight.lineIndex += 1;
        fight.nextLine = fight.elapsed + 1.25 + rng() * 0.5;
      }
      if (fight && fight.elapsed >= fight.duration) stopFight({ scored: true });
    }
  }

  function status() {
    return {
      fighting: !!fight,
      fighters: fight ? [fight.a.name, fight.b.name] : [],
      fightElapsed: fight ? Number(fight.elapsed.toFixed(1)) : 0,
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
