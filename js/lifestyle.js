// Villager lifestyle: five states and the schedule that drives them.
//
//   walking   - out and about in the village
//   watching  - standing outside, looking at the sky
//   chilling  - relaxing inside the room they were assigned
//   talking   - side by side with another villager, placeholder lines only
//   sleeping  - in their own bed, 22:00 to 08:00
//
// This module owns the decisions; NPC itself still does the walking, the collision
// guard and the in-room movement. It never draws anything and it never talks to the
// network, so the conversation layer can be swapped for real dialogue later.

import { findPath, doorApproach } from './pathing.js';

export const STATES = ['walking', 'watching', 'chilling', 'talking', 'sleeping'];

// Placeholder dialogue only: no API, no generation, just these lines.
export const PHRASES = [
  '…',
  'Hey!',
  'Nice weather today.',
  'How are you?',
  '…',
  'Have you been outside today?',
  'I was just relaxing.',
  'See you later!',
  'Lovely day, is it not?',
  'I could use a nap.',
];

const DURATION = {
  walking: [8, 16],
  watching: [14, 26],
  chilling: [16, 30],
  talking: [6, 11],
  visiting: 14,
};

const TALK_GAP = 20; // px between two villagers while they talk (side by side, not touching)
const TALK_REACH = 11; // tiles a villager will cross to start a conversation

const IDLE_STATES = new Set(['watching', 'chilling']);

export function createLifestyle({
  village, homes, clock, weather, roster = [], getNpcs, rng = Math.random,
  // Part 2: the conversation manager owns dialogue and conversation length; this
  // module still owns the state, the walking and the facing. partnerAppeal lets a
  // relationship pull two villagers together (or keep them apart).
  conversations = null,
  partnerAppeal = null,
}) {
  const T = village.tileSize;
  const rand = (a, b) => a + rng() * (b - a);
  const pick = (list) => list[Math.floor(rng() * list.length)];

  const simOf = (npc) => {
    if (!npc.sim) {
      npc.sim = {
        state: 'walking',
        timer: rand(1, 4),
        dialogue: null,
        partner: null,
        roomIndex: null,
        bed: null,
        seated: false,
        failTime: 0,
        bedTime: 0,
        approachTime: 0,
        previous: null,
        visitRoom: null,
        session: null,
      };
    }
    return npc.sim;
  };

  function rosterIndex(npc) {
    const id = npc.config ? npc.config.id : null;
    const at = roster.findIndex((entry) => entry.id === id);
    return at < 0 ? 0 : at;
  }

  function homeOf(npc) {
    const assignment = homes.assignment(npc.config ? npc.config.id : npc.name, rosterIndex(npc));
    return { room: homes.room(assignment.room), bed: homes.bed(assignment.bed) };
  }

  function roomObject(room) {
    return room ? village.rooms[room.index] || null : null;
  }

  // The tile a villager actually stands on to occupy a bed. Usually the bed's own
  // stand tile; if the furniture around it makes that unreachable, the nearest open
  // tile in the same room is used instead, so nobody ends the night in the corridor.
  function bedStand(bed, room) {
    const point = homes.bedPoint(bed);
    if (!room || !room.blocked || !bed.stand) return point;
    const [sx, sy] = bed.stand;
    const open = (x, y) => x >= room.x && y >= room.y
      && x < room.x + room.w && y < room.y + room.h
      && !room.blocked[(y - room.y) * room.w + (x - room.x)];
    if (open(Math.floor(sx), Math.floor(sy))) return point;
    let best = null;
    let bestGap = Infinity;
    for (let y = room.y; y < room.y + room.h; y++) {
      for (let x = room.x; x < room.x + room.w; x++) {
        if (!open(x, y)) continue;
        const gap = Math.hypot(x + 0.5 - sx, y + 0.5 - sy);
        if (gap < bestGap) {
          bestGap = gap;
          best = { x: (x + 0.5) * T, y: (y + 0.5) * T };
        }
      }
    }
    return best || point;
  }

  // ---------------------------------------------------------------- movement
  // Doorways are kept out of routes so nobody cuts through a house, but a villager
  // who has just stepped out of one is standing on that very tile: for them a route
  // without the door avoidance is the only way off the doorstep.
  function routeFrom(npc, goal) {
    const avoided = findPath(village, npc.tile, goal, { avoid: village.doorways });
    if (avoided && avoided.length) return avoided;
    return findPath(village, npc.tile, goal);
  }

  function walkTo(npc, goal) {
    if (!goal) return false;
    const path = routeFrom(npc, goal);
    if (!path || !path.length) return false;
    npc.path = path;
    npc.pendingRoom = null;
    npc.approach = null;
    npc.waitTime = 0;
    npc.moving = true;
    return true;
  }

  function leaveHouse(npc) {
    if (!npc.room) return false;
    npc.insideTimer = 0.25;
    npc.path = [];
    return true;
  }

  function enterHouse(npc, room, bed) {
    const target = roomObject(room);
    if (!target) return false;
    if (npc.room === target) return true;
    const approach = doorApproach(village, { x: room.door[0], y: room.door[1] });
    if (!approach) return false;
    const path = routeFrom(npc, approach);
    if (!path || !path.length) return false;
    npc.path = path;
    npc.approach = approach;
    npc.pendingRoom = target;
    npc.waitTime = 0;
    return true;
  }

  function wanderPoint(npc, radius) {
    const home = npc.home;
    for (let attempt = 0; attempt < 18; attempt++) {
      const x = Math.round(home.x + (rng() * 2 - 1) * radius);
      const y = Math.round(home.y + (rng() * 2 - 1) * radius);
      if (x < 1 || y < 1 || x >= village.cols - 1 || y >= village.rows - 1) continue;
      if (village.blockedValue(x, y) !== 0) continue;
      if (village.isDoorway(x, y)) continue;
      // a villager with no region of its own (-1) is not fenced in: comparing it to
      // the mask would reject every tile and leave them standing still all day
      if (village.region && npc.regionId >= 0
        && village.region[y * village.cols + x] !== npc.regionId) continue;
      return { x, y };
    }
    return null;
  }

  // Where a villager stands to have a conversation: right beside the other one.
  // Aiming at their house tile is what used to leave a pair "talking" from
  // opposite corners of the village, so this heads for the partner's own tile.
  // Standing across a doorway leaves a villager's sprite over the house, so the
  // doorstep and its neighbours are not conversation spots.
  function nearDoorway(x, y) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (village.isDoorway(x + dx, y + dy)) return true;
      }
    }
    return false;
  }

  function approachPoint(npc, partner) {
    const tx = Math.round((partner.x - T / 2) / T);
    const ty = Math.round((partner.y - T / 2) / T);
    // side by side reads better than head on: the sprites only face left and right
    const spots = [[tx - 1, ty], [tx + 1, ty], [tx, ty - 1], [tx, ty + 1], [tx, ty]];
    for (const [x, y] of spots) {
      if (x < 1 || y < 1 || x >= village.cols - 1 || y >= village.rows - 1) continue;
      if (village.blockedValue(x, y) !== 0 || village.isDoorway(x, y) || nearDoorway(x, y)) continue;
      if (village.region && npc.regionId >= 0
        && village.region[y * village.cols + x] !== npc.regionId) continue;
      if (walkTo(npc, { x, y })) return true;
    }
    return false;
  }

  // A conversation is a standstill: no path, no idle glance, eyes on the other one.
  function stopForTalk(npc) {
    npc.path = [];
    npc.moving = false;
    npc.waitTime = 1e9;
    npc.idleGlance = 1e9;
  }

  function faceEachOther(a, b) {
    const dx = b.x - a.x;
    if (Math.abs(dx) >= 0.5) {
      a.facing = dx > 0 ? 1 : -1;
      b.facing = -a.facing;
      return;
    }
    // stacked on the same column: roster order decides, so they still mirror
    const left = String((a.config && a.config.id) || a.name) < String((b.config && b.config.id) || b.name);
    a.facing = left ? 1 : -1;
    b.facing = -a.facing;
  }

  // ------------------------------------------------------------- daytime mix
  function counts() {
    const tally = { walking: 0, watching: 0, chilling: 0, talking: 0, sleeping: 0 };
    for (const npc of getNpcs()) {
      const state = npc.sim ? npc.sim.state : 'walking';
      // a debug room visit is just a walk from the mix's point of view
      if (state === 'visiting') tally.walking++;
      else if (tally[state] !== undefined) tally[state]++;
    }
    return tally;
  }

  // Half the village walks, a quarter idles and a quarter talks. The idle quarter is
  // split between watching the sky and relaxing indoors, and the state with the
  // biggest shortfall is chosen, so the mix holds without herding everybody at once.
  function nextDaytimeState(self) {
    const others = getNpcs().filter((npc) => npc !== self);
    const tally = counts();
    const own = self.sim ? self.sim.state : 'walking';
    if (tally[own] > 0) tally[own]--;

    const total = Math.max(1, others.length + 1);
    const want = {
      walking: Math.round(total * 0.5),
      idle: total - Math.round(total * 0.5) - Math.max(1, Math.round(total * 0.25)),
      talking: Math.max(1, Math.round(total * 0.25)),
    };

    const have = {
      walking: tally.walking,
      idle: tally.watching + tally.chilling,
      talking: tally.talking,
    };

    // Starting a conversation converts two villagers at once, so it only gets picked
    // when there is room for a whole pair. Without this the talking share overshoots
    // its quarter and the walkers are starved.
    const talkRoom = want.talking - have.talking;
    const options = [
      { key: 'walking', gap: want.walking - have.walking },
      { key: 'idle', gap: want.idle - have.idle },
      { key: 'talking', gap: talkRoom >= 2 ? talkRoom : -Infinity },
    ].sort((a, b) => b.gap - a.gap);

    const best = options[0];
    const tied = options.filter((option) => option.gap === best.gap);
    const choice = pick(tied).key;
    if (choice === 'idle') return rng() < 0.5 ? 'watching' : 'chilling';
    return choice;
  }

  // ------------------------------------------------------------------ states
  function startSleep(npc, sim) {
    const home = homeOf(npc);
    npc.waitTime = 0;
    sim.state = 'sleeping';
    sim.dialogue = null;
    sim.partner = null;
    sim.timer = 1e9;
    sim.bed = home.bed;
    sim.roomIndex = home.room ? home.room.index : null;
    sim.seated = false;
    sim.failTime = 0;
    sim.bedTime = 0;
    npc.pendingRoom = null;
    npc.approach = null;
    if (npc.room) {
      const bed = sim.bed || home.bed;
      if (bed) npc.insideTarget = bedStand(bed, roomObject(home.room));
      npc.insideTimer = 1e9;
      return;
    }
    if (!enterHouse(npc, home.room, home.bed)) {
      npc.path = [];
      npc.waitTime = 0.4;
    }
  }

  function wake(npc, sim) {
    sim.state = 'walking';
    sim.timer = rand(DURATION.walking[0], DURATION.walking[1]);
    sim.bed = null;
    sim.seated = false;
    npc.idleGlance = 0;
    sim.dialogue = null;
    if (npc.room) {
      npc.insideTimer = 0.25;
      npc.insideTarget = null;
      npc.path = [];
    } else {
      npc.waitTime = 0;
    }
  }

  function startWalk(npc, sim) {
    sim.state = 'walking';
    sim.timer = rand(DURATION.walking[0], DURATION.walking[1]);
    sim.dialogue = null;
    sim.partner = null;
    if (npc.room) {
      leaveHouse(npc);
      return;
    }
    const goal = wanderPoint(npc, 9);
    if (!goal || !walkTo(npc, goal)) npc.waitTime = 0.5;
  }

  function startWatch(npc, sim) {
    sim.state = 'watching';
    sim.timer = rand(DURATION.watching[0], DURATION.watching[1]);
    sim.dialogue = null;
    sim.partner = null;
    // when this villager next glances the other way while watching the sky
    sim.glance = 2 + rng() * 4;
    if (npc.room) {
      leaveHouse(npc);
      return;
    }
    const goal = wanderPoint(npc, 6);
    if (goal && walkTo(npc, goal)) {
      npc.path = npc.path.slice(0, Math.max(1, npc.path.length)); // keep the walk short
    } else {
      npc.path = [];
      npc.waitTime = sim.timer;
      npc.facing = rng() < 0.5 ? 1 : -1;
    }
  }

  function startChill(npc, sim) {
    const home = homeOf(npc);
    sim.state = 'chilling';
    sim.timer = rand(DURATION.chilling[0], DURATION.chilling[1]);
    sim.dialogue = null;
    sim.partner = null;
    sim.bed = home.bed;
    sim.roomIndex = home.room ? home.room.index : null;
    npc.pendingRoom = null;
    npc.approach = null;
    if (npc.room) {
      npc.insideTarget = npc.randomInsidePoint(npc.room);
      npc.insideTimer = 1e9;
      return;
    }
    if (!enterHouse(npc, home.room, home.bed)) startWalk(npc, sim);
  }

  function freeForTalk(npc) {
    if (npc.room) return false;
    if (!npc.sim) return true;
    return npc.sim.state === 'walking' || npc.sim.state === 'watching';
  }

  function startTalk(npc, sim) {
    // Any free villager close enough is a candidate, but only one we can actually
    // walk to: a conversation never starts across the river or a fence.
    const others = getNpcs()
      .filter((other) => other !== npc && freeForTalk(other)
        && Math.hypot(other.x - npc.x, other.y - npc.y) <= TALK_REACH * T
        && !nearDoorway(other.tile.x, other.tile.y))
      .map((other) => ({
        other,
        distance: Math.hypot(other.x - npc.x, other.y - npc.y),
        // friends are worth the walk; someone they cannot stand is not
        appeal: partnerAppeal ? Math.max(0.02, partnerAppeal(npc, other)) : 1,
      }))
      .filter((candidate) => candidate.appeal > 0.12)
      .sort((a, b) => a.distance / a.appeal - b.distance / b.appeal);

    for (const { other: partner } of others) {
      const partnerSim = simOf(partner);
      if (partnerSim.partner && partnerSim.partner !== npc) continue;
      // two villagers who have just talked wait out their cooldown first
      if (conversations && !conversations.canTalk(npc, partner)) continue;
      if (!approachPoint(npc, partner)) continue;

      const session = conversations ? conversations.begin(npc, partner) : null;
      if (conversations && !session) continue;

      sim.state = 'talking';
      sim.partner = partner;
      sim.approachTime = 0;
      // with a session running, the conversation manager ends the chat in its own
      // time; this timer is only the safety net that keeps a villager moving
      sim.timer = session ? 600 : rand(DURATION.talking[0], DURATION.talking[1]);
      sim.dialogue = session ? '…' : pick(PHRASES);
      sim.session = session || null;

      partnerSim.state = 'talking';
      partnerSim.partner = npc;
      partnerSim.timer = sim.timer;
      partnerSim.dialogue = session ? '…' : pick(PHRASES);
      partnerSim.approachTime = 0;
      partnerSim.session = session || null;

      // the partner holds still and turns to face us while we walk over
      stopForTalk(partner);
      faceEachOther(npc, partner);
      return true;
    }

    startWalk(npc, sim);
    return false;
  }

  function planNext(npc, sim) {
    // whatever the last state left behind, a new plan starts from a clean slate
    sim.visitRoom = null;
    npc.waitTime = 0;
    npc.idleGlance = 0;
    if (clock.isNight()) {
      startSleep(npc, sim);
      return;
    }
    if (sim.state === 'sleeping') {
      wake(npc, sim);
      return;
    }
    // A room visit or a repainted layout can leave someone in a house that is not
    // theirs: walk back out before anything else is planned.
    const home = homeOf(npc);
    const ownRoom = roomObject(home.room);
    if (npc.room && ownRoom && npc.room !== ownRoom) {
      leaveHouse(npc);
      sim.state = 'walking';
      sim.timer = rand(DURATION.walking[0], DURATION.walking[1]);
      return;
    }
    const state = nextDaytimeState(npc);
    if (state === 'walking') startWalk(npc, sim);
    else if (state === 'watching') startWatch(npc, sim);
    else if (state === 'chilling') startChill(npc, sim);
    else if (!startTalk(npc, sim)) startWalk(npc, sim);
  }

  // Letting an idle timeout run planNext in the middle of a chat used to end the
  // conversation early and send everyone off mid-sentence. Hold the pose instead;
  // the chat timer ends it properly.
  function continueFromWait(npc, sim) {
    const partner = sim.partner;
    if (sim.state === 'talking' && partner && partner.sim && partner.sim.state === 'talking') {
      stopForTalk(npc);
      faceEachOther(npc, partner);
      return;
    }
    planNext(npc, sim);
  }

  // --------------------------------------------------------- per-frame upkeep
  function upkeep(npc, sim, dt) {
    if (sim.state === 'sleeping') {
      const home = homeOf(npc);
      if (!npc.room) {
        sim.failTime += dt;
        if (!npc.path.length && npc.waitTime <= 0) {
          if (!enterHouse(npc, home.room, home.bed)) {
            // boxed out of the house: fall back to stepping through the doorway so
            // nobody ever spends the night on the street
            if (sim.failTime > 6 && home.room) {
              const room = roomObject(home.room);
              if (room) npc.enter(room);
            }
            npc.waitTime = 0.5;
          }
        }
        return;
      }
      const bed = sim.bed || home.bed;
      if (!bed) return;
      const point = bedStand(bed, roomObject(home.room));
      npc.insideTimer = 1e9;
      if (!npc.insideTarget
        || Math.abs(npc.insideTarget.x - point.x) > 0.5
        || Math.abs(npc.insideTarget.y - point.y) > 0.5) {
        npc.insideTarget = point;
      }
      const bedGap = Math.hypot(npc.x - point.x, npc.y - point.y);
      sim.bedTime += dt;
      if (bedGap < 2) {
        sim.bedTime = 0;
        sim.seated = true;
        npc.moving = false;
        npc.facing = bed.facing;
        if (!sim.dialogue) sim.dialogue = 'Zzz';
      } else if (sim.bedTime > 8) {
        // home, but the furniture blocks the very last tile: settle onto the bed
        // instead of hovering in the room until morning
        npc.path = [];
        npc.moving = false;
        npc.x = point.x;
        npc.y = point.y;
        npc.insideTarget = point;
        sim.seated = true;
        sim.bedTime = 0;
        npc.facing = bed.facing;
        if (!sim.dialogue) sim.dialogue = 'Zzz';
      }
      return;
    }

    if (clock.isNight()) return; // handled by update()

    if (sim.state === 'visiting') {
      const room = sim.visitRoom;
      if (!room) {
        planNext(npc, sim);
        return;
      }
      if (npc.room === room) {
        npc.insideTimer = 1e9;
        if (!npc.insideTarget) npc.insideTarget = npc.randomInsidePoint(room);
        return;
      }
      if (!npc.path.length && npc.waitTime <= 0) {
        const record = { index: village.rooms.indexOf(room), door: [room.door.x, room.door.y] };
        if (!enterHouse(npc, record, null)) npc.waitTime = 0.5;
      }
      return;
    }

    if (sim.state === 'chilling') {
      if (!npc.room) {
        const home = homeOf(npc);
        if (!npc.path.length && npc.waitTime <= 0 && !enterHouse(npc, home.room, home.bed)) {
          startWalk(npc, sim);
        }
        return;
      }
      npc.insideTimer = 1e9;
      if (!npc.insideTarget) npc.insideTarget = npc.randomInsidePoint(npc.room);
      return;
    }

    if (sim.state === 'talking') {
      const partner = sim.partner;
      // A partner who is no longer talking to *us* has moved on: follow them instead
      // of standing here facing a villager who is already walking away.
      if (!partner || !partner.sim || partner.sim.state !== 'talking'
        || partner.sim.partner !== npc || partner.room) {
        sim.partner = null;
        planNext(npc, sim);
        return;
      }
      const gap = Math.hypot(partner.x - npc.x, partner.y - npc.y);
      if (gap > TALK_GAP) {
        sim.approachTime = (sim.approachTime || 0) + dt;
        // when a conversation session exists the manager owns this deadline and
        // abandons the chat (handing both villagers back) on its own
        if (sim.approachTime > 12 && !sim.session) {
          // someone is behind a fence or simply too far away: stop pretending to
          // converse across the village and let them get on with their day
          sim.partner = null;
          if (partner.sim) partner.sim.partner = null;
          planNext(npc, sim);
          return;
        }
        // still on the way in: close the distance, or wait and try again shortly
        if (!npc.path.length && !approachPoint(npc, partner)) npc.waitTime = 0.4;
        return;
      }
      sim.approachTime = 0;
      stopForTalk(npc);
      faceEachOther(npc, partner);
      return;
    }

    if (sim.state === 'watching') {
      if (npc.room) {
        leaveHouse(npc);
        return;
      }
      if (!npc.path.length) {
        npc.moving = false;
        // Looking about is a glance every few seconds. This used to re-roll the facing
        // on every frame, which made a watcher twitch left and right continuously.
        if (sim.glance === undefined) sim.glance = 2 + rng() * 4;
        sim.glance -= dt;
        if (sim.glance <= 0) {
          if (rng() < 0.5) npc.facing = -npc.facing;
          sim.glance = 4 + rng() * 5;
        }
      }
      return;
    }

    // walking: an empty path means the stroll is over. A pending door errand is left
    // alone so NPC can act on it instead of being held in an endless short wait.
    if (sim.state === 'walking' && !npc.path.length && !npc.pendingRoom && npc.waitTime > 0.25) {
      // clamp a leftover wait, but leave a short one alone so it can run out and
      // ask for a new plan
      npc.waitTime = 0.2;
    }
  }

  // ------------------------------------------------------------------- public
  const lifestyle = {
    start() {
      for (const npc of getNpcs()) {
        const sim = simOf(npc);
        npc.onPlan = (who) => continueFromWait(who, simOf(who));
        if (clock.isNight()) startSleep(npc, sim);
        else planNext(npc, sim);
      }
    },

    update(dt) {
      // conversations pace themselves on the same simulated clock as the villagers,
      // so a fast-forwarded frame advances a chat the same way a real one would
      if (conversations) conversations.update(dt);
      const npcs = getNpcs();
      for (const npc of npcs) {
        const sim = simOf(npc);
        const before = sim.state;
        // The clock only runs once a villager has arrived: a room visit is not over
        // because the walk took a while, and a chat does not burn its time while the
        // pair is still walking up to each other.
        const visiting = sim.state === 'visiting' && sim.visitRoom && npc.room !== sim.visitRoom;
        const apart = sim.state === 'talking' && sim.partner
          && Math.hypot(sim.partner.x - npc.x, sim.partner.y - npc.y) > TALK_GAP;
        if (!visiting && !apart) sim.timer -= dt;
        if (clock.isNight()) {
          if (sim.state !== 'sleeping') startSleep(npc, sim);
        } else if (sim.state === 'sleeping') {
          wake(npc, sim);
        } else if (sim.timer <= 0) {
          planNext(npc, sim);
        }
        // remembering the last state is what makes the studio readout and the
        // debug panel able to say where a villager came from
        if (sim.state !== before) sim.previous = before;
        upkeep(npc, sim, dt);
        npc.update(dt);
      }
    },

    // Layout edits move rooms and beds, so everyone re-plans from where they stand.
    replanAll() {
      for (const npc of getNpcs()) {
        const sim = simOf(npc);
        npc.path = [];
        npc.pendingRoom = null;
        npc.approach = null;
        // only leave the room if it was rebuilt away underneath them
        if (npc.room && !village.rooms.includes(npc.room)) npc.room = null;
        npc.waitTime = 0.2;
        sim.timer = 0;
        sim.partner = null;
        sim.dialogue = null;
      }
    },

    sleepNow() {
      for (const npc of getNpcs()) startSleep(npc, simOf(npc));
    },

    // Called by the conversation manager when a chat is over: forget the partner,
    // drop the session and let the villager get on with the rest of their day.
    handBack(npc) {
      if (!npc) return;
      const sim = simOf(npc);
      if (sim.state === 'talking') {
        sim.state = 'walking';
        sim.timer = rand(2.5, 5);
      }
      sim.partner = null;
      sim.session = null;
      sim.dialogue = null;
      sim.approachTime = 0;
      npc.path = [];
      npc.moving = false;
      npc.idleGlance = 0;
      npc.waitTime = 0.15;
    },

    // Debug hook inherited from the room editor: walk a villager into a room, let
    // them look around for a moment, then hand them back to the lifestyle machine.
    visit(npc, room) {
      if (!npc || !room || room.w <= 0 || room.h <= 0) return false;
      const sim = simOf(npc);
      sim.partner = null;
      sim.dialogue = null;
      sim.visitRoom = room;
      sim.state = 'visiting';
      sim.timer = DURATION.visiting;
      npc.pendingRoom = null;
      npc.approach = null;
      if (npc.room === room) {
        npc.insideTimer = 1e9;
        npc.insideTarget = npc.randomInsidePoint(room);
        return true;
      }
      const approach = doorApproach(village, room.door);
      if (!approach) return false;
      const path = findPath(village, npc.tile, approach, { avoid: village.doorways });
      if (!path || !path.length) return false;
      npc.path = path;
      npc.approach = approach;
      npc.pendingRoom = room;
      npc.waitTime = 0;
      return true;
    },

    snapshot() {
      return getNpcs().map((npc) => {
        const sim = simOf(npc);
        const home = homeOf(npc);
        return {
          id: npc.config ? npc.config.id : '',
          name: npc.name,
          state: sim.state,
          previous: sim.previous || null,
          inside: !!npc.room,
          roomIndex: home.room ? home.room.index : sim.roomIndex,
          // while awake the assignment is what matters; the sim's bed is the one
          // they are actually lying in, which only differs mid-transition
          bed: sim.state === 'sleeping' && sim.bed ? sim.bed.id : (home.bed ? home.bed.id : null),
          destination: npc.path.length
            ? { x: npc.path[npc.path.length - 1].x, y: npc.path[npc.path.length - 1].y }
            : npc.insideTarget
              ? { x: Math.round(npc.insideTarget.x / T), y: Math.round(npc.insideTarget.y / T) }
              : null,
          dialogue: sim.dialogue,
          moving: !!npc.moving,
          
          session: sim.session
            ? { id: sim.session.id, status: sim.session.status, messages: sim.session.messages.length, target: sim.session.target }
            : null,
          x: Math.round(npc.x),
          y: Math.round(npc.y),
        };
      });
    },

    states: () => counts(),
    homeOf,
    npcSim: (npc) => simOf(npc),
    weather: () => (weather ? weather.state() : null),
  };

  return lifestyle;
}
