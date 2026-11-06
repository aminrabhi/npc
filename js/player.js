// The player-controlled character.
//
// It is the same NPC object the village already draws, talks to and remembers; the
// only difference is that this module owns its movement instead of the lifestyle
// planner. That keeps the player inside the village's collision, facing and sprite
// rules without creating a second kind of character.

const MOVE_KEYS = {
  KeyW: [0, -1],
  ArrowUp: [0, -1],
  KeyS: [0, 1],
  ArrowDown: [0, 1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
};

const SPEED = 52; // pixels per second; just over three tiles a second

function isTypingTarget(target) {
  if (!target || !target.tagName) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
}

export function createPlayerController({ canvas, state, village, getNpcs, canControl = () => true, openChat, onSummon = null }) {
  const held = new Set();
  const T = village.tileSize;

  function player() {
    if (!state.playerId) return null;
    return getNpcs().find((npc) => npc.config && npc.config.id === state.playerId) || null;
  }

  function openSpotNear(tile) {
    const start = { x: tile[0] | 0, y: tile[1] | 0 };
    if (village.blockedValue(start.x, start.y) === 0) return start;
    for (let r = 1; r <= 8; r += 1) {
      for (let dy = -r; dy <= r; dy += 1) {
        for (let dx = -r; dx <= r; dx += 1) {
          const x = start.x + dx;
          const y = start.y + dy;
          if (x < 0 || y < 0 || x >= village.cols || y >= village.rows) continue;
          if (village.blockedValue(x, y) !== 0) continue;
          return { x, y };
        }
      }
    }
    return start;
  }

  // Put the character on their home tile, outside, with an empty walking state.
  // This is also what runs when the studio switches from one character to another.
  function spawn() {
    const npc = player();
    if (!npc) return false;
    const entry = npc.config || {};
    const home = Array.isArray(entry.home) ? entry.home : [npc.home.x, npc.home.y];
    const spot = openSpotNear(home);
    entry.home = [spot.x, spot.y];
    npc.home = { ...spot };
    npc.room = null;
    npc.pendingRoom = null;
    npc.approach = null;
    npc.path = [];
    npc.moving = false;
    npc.waitTime = 0;
    npc.insideTimer = 0;
    npc.insideTarget = null;
    npc.x = spot.x * T + T / 2;
    npc.y = spot.y * T + T / 2;
    npc.facing = 1;
    npc.sim = {
      state: 'walking',
      timer: 1e9,
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
    return true;
  }

  // The I hotkey drops the baked player onto a bed. The room is kept on the NPC so
  // the room art is visible and indoor movement uses the room's own collision.
  function spawnOnBed({ room, bed }) {
    const npc = player();
    if (!npc || !bed) return false;
    const stand = Array.isArray(bed.stand) ? bed.stand : [bed.tile[0] + 0.5, bed.tile[1] + 0.5];
    const x = stand[0] * T;
    const y = stand[1] * T;
    npc.room = room || null;
    npc.pendingRoom = null;
    npc.approach = null;
    npc.path = [];
    npc.moving = false;
    npc.waitTime = 0;
    npc.insideTimer = 1e9;
    npc.insideTarget = { x, y };
    npc.insideSteps = null;
    npc.insideBumps = 0;
    npc.leaveTime = 0;
    npc.x = x;
    npc.y = y;
    npc.facing = bed.facing === -1 ? -1 : 1;
    npc.sim = {
      state: 'chilling',
      timer: 1e9,
      dialogue: null,
      partner: null,
      roomIndex: room ? village.rooms.indexOf(room) : null,
      bed,
      seated: true,
      failTime: 0,
      bedTime: 0,
      approachTime: 0,
      previous: null,
      visitRoom: null,
      session: null,
    };
    return true;
  }

  // Furniture inside a room is solid, and the room rectangle is the outer wall.
  function indoorBlockedAt(room, x, y) {
    const left = room.x * T + 1;
    const right = (room.x + room.w) * T - 1;
    const top = room.y * T + 1;
    const bottom = (room.y + room.h) * T - 1;
    if (x < left || x > right || y < top || y > bottom) return true;
    return village.roomBlockedArea(room, x, y);
  }

  // Let the lifestyle machine have the body back when the player stops controlling
  // this character. Keeping the same NPC object is what preserves its relationships.
  function release() {
    const npc = player();
    if (!npc) return false;
    npc.path = [];
    npc.moving = false;
    npc.waitTime = 0.15;
    npc.pendingRoom = null;
    npc.approach = null;
    npc.insideTarget = null;
    npc.sim = npc.sim || {};
    npc.sim.state = 'walking';
    npc.sim.timer = 1;
    npc.sim.partner = null;
    npc.sim.session = null;
    npc.sim.dialogue = null;
    npc.sim.approachTime = 0;
    return true;
  }

  function update(dt) {
    const npc = player();
    if (!npc) return;
    npc.animTime += dt;

    // Conversations are a standstill. The chat panel owns the body while it is open,
    // and an editor also freezes the village in the same way.
    if (!canControl() || (npc.sim && npc.sim.state === 'talking')) {
      npc.moving = false;
      return;
    }

    let dx = 0;
    let dy = 0;
    for (const code of held) {
      const move = MOVE_KEYS[code];
      if (move) {
        dx += move[0];
        dy += move[1];
      }
    }
    if (dx === 0 && dy === 0) {
      npc.moving = false;
      return;
    }

    const length = Math.hypot(dx, dy);
    dx /= length;
    dy /= length;
    const step = SPEED * dt;

    // Indoors the player walks on the room floor and around its furniture. The
    // doorway is the only exit: moving into it steps out to the door tile.
    if (npc.room) {
      const room = npc.room;
      const doorX = room.door.x * T + T / 2;
      const doorY = room.door.y * T + T / 2;
      const toDoorX = doorX - npc.x;
      const toDoorY = doorY - npc.y;
      const doorGap = Math.hypot(toDoorX, toDoorY);
      const towardDoor = doorGap > 0.001
        ? (toDoorX * dx + toDoorY * dy) / doorGap
        : 0;
      if (doorGap <= T * 0.85 && towardDoor > 0.45) {
        npc.exitRoom();
        npc.path = [];
        npc.waitTime = 0;
        npc.moving = false;
        if (npc.sim) {
          npc.sim.state = 'walking';
          npc.sim.roomIndex = null;
          npc.sim.bed = null;
          npc.sim.seated = false;
        }
        return;
      }

      const nx = npc.x + dx * step;
      if (!indoorBlockedAt(room, nx, npc.y)) npc.x = nx;
      const ny = npc.y + dy * step;
      if (!indoorBlockedAt(room, npc.x, ny)) npc.y = ny;
      npc.x = Math.max(room.x * T + 1, Math.min((room.x + room.w) * T - 1, npc.x));
      npc.y = Math.max(room.y * T + 1, Math.min((room.y + room.h) * T - 1, npc.y));
      npc.moving = true;
      if (Math.abs(dx) > 0.05) npc.facing = dx > 0 ? 1 : -1;
      if (npc.sim) {
        npc.sim.state = 'walking';
        npc.sim.dialogue = null;
      }
      return;
    }

    // Move one axis at a time so a wall stops one direction without making the
    // character stick to it when the other direction is still open.
    const nx = npc.x + dx * step;
    if (!village.feetBlockedAt(nx, npc.y)) npc.x = nx;
    const ny = npc.y + dy * step;
    if (!village.feetBlockedAt(npc.x, ny)) npc.y = ny;

    npc.x = Math.max(2, Math.min(village.width - 2, npc.x));
    npc.y = Math.max(2, Math.min(village.height - 2, npc.y));

    // Walking into a doorway from outside enters that room. The same door test is
    // used in reverse indoors, so the player can go back and forth normally.
    const doorRoom = village.rooms.find((room) => {
      if (!room || room.w <= 0 || room.h <= 0) return false;
      const gap = Math.hypot(
        npc.x - (room.door.x * T + T / 2),
        npc.y - (room.door.y * T + T / 2),
      );
      return gap <= T * 0.8;
    });
    if (doorRoom) {
      const doorX = doorRoom.door.x * T + T / 2;
      const doorY = doorRoom.door.y * T + T / 2;
      const centerX = (doorRoom.x + doorRoom.w / 2) * T;
      const centerY = (doorRoom.y + doorRoom.h / 2) * T;
      const toX = centerX - doorX;
      const toY = centerY - doorY;
      const gap = Math.hypot(toX, toY);
      const inward = gap > 0.001 ? (toX * dx + toY * dy) / gap : 0;
      if (inward > 0.45) {
        npc.enter(doorRoom);
        npc.path = [];
        npc.waitTime = 0;
        npc.moving = false;
        if (npc.sim) {
          npc.sim.state = 'walking';
          npc.sim.roomIndex = village.rooms.indexOf(doorRoom);
          npc.sim.bed = null;
          npc.sim.seated = false;
        }
        return;
      }
    }

    npc.moving = true;
    if (Math.abs(dx) > 0.05) npc.facing = dx > 0 ? 1 : -1;
    if (npc.sim) {
      npc.sim.state = 'walking';
      npc.sim.dialogue = null;
    }
  }

  function keydown(ev) {
    if (ev.defaultPrevented) return;
    if (isTypingTarget(ev.target)) return;

    if (ev.key === '/' && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      ev.preventDefault();
      if (openChat) openChat();
      return;
    }

    if (ev.code === 'KeyI' && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      if (!canControl()) return;
      ev.preventDefault();
      if (onSummon) onSummon();
      return;
    }

    if (!canControl()) return;
    if (!MOVE_KEYS[ev.code]) return;
    held.add(ev.code);
    ev.preventDefault();
  }

  function keyup(ev) {
    held.delete(ev.code);
  }

  function clearKeys() {
    held.clear();
  }

  window.addEventListener('keydown', keydown);
  window.addEventListener('keyup', keyup);
  window.addEventListener('blur', clearKeys);
  // Clicking back onto the village should not leave a movement key stuck down.
  canvas.addEventListener('pointerdown', clearKeys);

  return {
    update,
    spawn,
    spawnOnBed,
    release,
    player,
    isControlled: () => !!player(),
    isTypingTarget,
    clearKeys,
  };
}
