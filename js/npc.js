// Villager: a body/hair/hand sprite stack that mostly stays put.
//
// Villagers are not wanderers. Each one has a home tile they belong to, and the day
// is spent idling there with the occasional short stroll or a walk to a doorway.
// When a stroll ends they head back home. All movement still goes through the same
// BFS pathing, collision guard and doorway rules as before.

import { findPath, doorApproach } from './pathing.js';
import { drawHeldItem } from './items.js';
import { drawEmote } from './emotes.js';

const CELL_W = 96;
const CELL_H = 64;
const FEET_X = 48; // character's horizontal centre inside the sprite cell
const FEET_Y = 39; // character's feet row inside the sprite cell

const WALK_FRAMES = 8;
const IDLE_FRAMES = 9;

const HOME_IDLE_MIN = 12;
const HOME_IDLE_MAX = 26;
const STROLL_RADIUS = 4;
const DOOR_CHANCE = 0.12;
const STROLL_CHANCE = 0.45;
// A door is only worth a trip if it is a short walk from where they belong.
const VISIT_RADIUS = 12;

export class NPC {
  constructor({ village, sheets, name, home, config, cell, regionId, rng }) {
    this.village = village;
    this.rng = rng;
    this.regionId = regionId;
    this.config = config || null;
    this.isPlayer = false;

    this.sheets = sheets;
    this.name = name || '';
    // What this villager carries in their hand when they are not fighting. The
    // sword replaces it for the length of a fight and is handed back afterwards.
    this.heldItem = (config && config.heldItem) || null;

    const T = village.tileSize;
    const start = cell || home || { x: 0, y: 0 };
    this.home = { x: start.x, y: start.y };
    this.x = start.x * T + T / 2;
    this.y = start.y * T + T / 2;

    this.speed = 22 + rng() * 10;
    this.path = [];
    this.waitTime = 0.6 + rng() * 2.4;
    this.animTime = rng() * 2;
    this.facing = rng() < 0.5 ? 1 : -1;
    this.moving = false;
    this.stuckTime = 0;
    this.idleGlance = 2 + rng() * 4;

    // room visit state
    this.room = null;
    this.pendingRoom = null;
    this.approach = null;
    this.insideTimer = 0;
    this.insideTarget = null;
  }

  get tile() {
    const T = this.village.tileSize;
    return {
      x: Math.floor(this.x / T),
      y: Math.floor(this.y / T),
    };
  }

  get atHome() {
    const tile = this.tile;
    return Math.abs(tile.x - this.home.x) <= 1 && Math.abs(tile.y - this.home.y) <= 1;
  }

  setHome(home) {
    if (!home) return;
    this.home = { x: home.x, y: home.y };
  }

  // ------------------------------------------------------------------ planning
  // One decision: go home, look at a door, take a short stroll, or simply stand.
  plan() {
    const tile = this.tile;
    const away = Math.abs(tile.x - this.home.x) + Math.abs(tile.y - this.home.y);

    if (away > 1 && this.rng() < 0.8 && this.walkHome()) return;

    const roll = this.rng();
    if (roll < DOOR_CHANCE && this.visitRoom()) return;
    if (roll < DOOR_CHANCE + STROLL_CHANCE && this.stroll()) return;
    this.idle();
  }

  idle() {
    this.path = [];
    this.pendingRoom = null;
    this.approach = null;
    this.moving = false;
    this.waitTime = HOME_IDLE_MIN + this.rng() * (HOME_IDLE_MAX - HOME_IDLE_MIN);
  }

  // Arrived with nothing left to do: go back to the spot they belong to.
  settle() {
    this.moving = false;
    // The social layer is steering this villager (a fight, a chase or a knockout).
    // Falling back to the idle planner here is what made fighters reach each other
    // and then stroll home in opposite directions, because squaring up clears their
    // paths and looks exactly like a finished errand.
    if (this.sim && (this.sim.fighting || this.sim.stunned)) return;
    if (this.onPlan) {
      this.onPlan(this);
      return;
    }
    if (!this.atHome && this.walkHome()) return;
    this.idle();
  }

  walkHome() {
    const path = findPath(this.village, this.tile, this.home, { avoid: this.village.doorways });
    if (!path || path.length === 0) return false;
    this.path = path;
    this.pendingRoom = null;
    this.approach = null;
    return true;
  }

  stroll() {
    const { village, rng } = this;
    const from = this.tile;
    const here = this.regionId;

    for (let attempt = 0; attempt < 12; attempt++) {
      const dx = Math.round((rng() * 2 - 1) * STROLL_RADIUS);
      const dy = Math.round((rng() * 2 - 1) * STROLL_RADIUS);
      if (dx === 0 && dy === 0) continue;
      const gx = this.home.x + dx;
      const gy = this.home.y + dy;

      if (gx < 0 || gy < 0 || gx >= village.cols || gy >= village.rows) continue;
      if (village.isSolid(gx, gy)) continue;
      if (village.isDoorway(gx, gy)) continue;
      if (village.region && village.region[gy * village.cols + gx] !== here) continue;

      const path = findPath(village, from, { x: gx, y: gy }, { avoid: village.doorways });
      if (path && path.length > 1) {
        this.path = path;
        this.pendingRoom = null;
        this.approach = null;
        return true;
      }
    }
    return false;
  }

  visitRoom() {
    const { village, rng } = this;
    const rooms = (village.rooms || []).filter((r) => r.w > 0 && r.h > 0
      && Math.abs(r.door.x - this.home.x) + Math.abs(r.door.y - this.home.y) <= VISIT_RADIUS);
    if (rooms.length === 0) return false;

    const room = rooms[Math.floor(rng() * rooms.length)];
    const approach = doorApproach(village, room.door);
    const reachable = approach
      && (!village.region || village.region[approach.y * village.cols + approach.x] === this.regionId);
    if (!reachable) return false;

    const path = findPath(village, this.tile, approach, { avoid: village.doorways });
    if (!path) return false;

    this.path = path;
    this.approach = approach;
    this.pendingRoom = room;
    return true;
  }

  // ------------------------------------------------------------------ movement
  update(dt) {
    this.animTime += dt;

    if (this.room) {
      this.updateInside(dt);
      return;
    }

    if (this.waitTime > 0) {
      this.waitTime -= dt;
      this.moving = false;
      // standing about is not frozen: now and then they look the other way
      this.idleGlance -= dt;
      if (this.idleGlance <= 0) {
        if (this.rng() < 0.5) this.facing = -this.facing;
        this.idleGlance = 2 + this.rng() * 5;
      }
      if (this.waitTime <= 0) {
        // the lifestyle machine decides what happens next; without it a villager
        // falls back to the original idle / stroll / door routine
        if (this.onPlan) this.onPlan(this);
        else this.plan();
      }
      return;
    }

    if (this.path.length === 0) {
      if (this.pendingRoom) {
        // Only step inside from the doorway tile itself: a path that got cancelled
        // on the way must never warp a villager into a house from across the map.
        const here = this.tile;
        const door = this.approach;
        if (door && here.x === door.x && here.y === door.y) {
          this.enter(this.pendingRoom);
          return;
        }
        this.pendingRoom = null;
        this.approach = null;
      }
      this.settle();
      return;
    }

    const T = this.village.tileSize;
    const next = this.path[0];
    const targetX = this.laneX(next);
    const targetY = next.y * T + T / 2;

    const dx = targetX - this.x;
    const dy = targetY - this.y;
    const dist = Math.hypot(dx, dy);
    const step = this.speed * dt;

    // A collision box is never entered, not even by the last pixel of a step or by
    // the snap onto a waypoint.
    if (dist <= step || dist < 0.001) {
      if (this.village.feetBlockedAt(targetX, targetY)) {
        this.stuck(dt);
        return;
      }
      this.x = targetX;
      this.y = targetY;
      this.path.shift();
      this.moving = true;
      this.stuckTime = 0;
      if (this.path.length === 0) {
        if (this.pendingRoom) {
          this.enter(this.pendingRoom);
          return;
        }
        this.idle();
      }
      return;
    }

    const ux = dx / dist;
    const uy = dy / dist;

    // Guard against ever stepping onto a blocked box. The test is in pixels so a
    // half-width box only stops the step that enters its own half.
    const nx = this.x + ux * step;
    const ny = this.y + uy * step;
    if (this.village.feetBlockedAt(nx, ny)) {
      this.stuck(dt);
      return;
    }

    this.x = nx;
    this.y = ny;
    this.moving = true;
    if (Math.abs(ux) > 0.15) this.facing = ux > 0 ? 1 : -1;
  }

  // Standing against something solid: hold still, and give up on the errand if it
  // stays in the way instead of pushing through it.
  stuck(dt) {
    this.stuckTime += dt;
    if (this.stuckTime > 0.6) {
      // bumping into a wall cancels the errand, including the door it was heading for
      this.path = [];
      this.pendingRoom = null;
      this.approach = null;
      this.stuckTime = 0;
      this.moving = false;
      this.waitTime = 0.4 + this.rng() * 1.2;
    }
    this.moving = false;
  }

  // ------------------------------------------------------------- room visits
  // Reaching the doorway puts the villager inside its room, drawn over the map
  // tiles where the room's interior art lives.
  // The doorway tile is the anchor for both ends of a visit, so a villager always
  // arrives and leaves at the middle of the door instead of somewhere across the room.
  doorCentre(room) {
    const T = this.village.tileSize;
    return { x: room.door.x * T + T / 2, y: room.door.y * T + T / 2 };
  }

  enter(room) {
    const spot = this.doorCentre(room);
    this.room = room;
    this.pendingRoom = null;
    this.path = [];
    this.moving = false;
    this.x = spot.x;
    this.y = spot.y;
    this.insideTarget = null;
    this.insideSteps = null;
    this.insideBumps = 0;
    this.leaveTime = 0;
    this.insideTimer = 4 + this.rng() * 5;
  }

  exitRoom() {
    const T = this.village.tileSize;
    const room = this.room;
    let door = room ? room.door : this.approach;

    this.room = null;
    this.insideTarget = null;
    this.insideSteps = null;
    this.insideBumps = 0;
    this.approach = null;
    this.moving = false;
    this.waitTime = 0;

    if (!this.village.isWalkable(door.x, door.y)) {
      const beside = doorApproach(this.village, door);
      if (beside) door = beside;
    }
    this.x = door.x * T + T / 2;
    this.y = door.y * T + T / 2;

    // Walk away from the doorway instead of standing in it: the sprite stands about
    // two tiles tall, so it needs to be clear of the door to stop looking like it is
    // half inside the house wall.
    this.path = this.stepOutPath(room, door);
    if (this.path.length === 0) this.waitTime = 0.6 + this.rng() * 1.5;
  }

  // Tiles to walk along after leaving a room, starting with the side of the room the
  // door is on and falling back to any open direction.
  stepOutPath(room, door) {
    const village = this.village;
    const dirs = [];
    if (room) {
      if (door.y === room.y + room.h - 1) dirs.push({ x: 0, y: 1 });
      if (door.y === room.y) dirs.push({ x: 0, y: -1 });
      if (door.x === room.x + room.w - 1) dirs.push({ x: 1, y: 0 });
      if (door.x === room.x) dirs.push({ x: -1, y: 0 });
    }
    dirs.push({ x: 0, y: 1 }, { x: 0, y: -1 }, { x: 1, y: 0 }, { x: -1, y: 0 });

    for (const d of dirs) {
      const steps = [];
      for (let n = 1; n <= 3; n++) {
        const x = door.x + d.x * n;
        const y = door.y + d.y * n;
        if (!village.isWalkable(x, y)) break;
        steps.push({ x, y });
      }
      if (steps.length) return steps;
    }
    return [];
  }

  // Half-width boxes mean the walkable lane through a tile is the half that is open.
  laneX(tile) {
    const T = this.village.tileSize;
    const box = this.village.blockedValue(tile.x, tile.y);
    if (box === 2) return tile.x * T + T * 0.75;
    if (box === 3) return tile.x * T + T * 0.25;
    return tile.x * T + T / 2;
  }

  // A spot to wander to inside the room. Solid furniture painted in the editor's
  // door view is skipped, so nobody stands inside a bed.
  randomInsidePoint(room) {
    const T = this.village.tileSize;
    const minX = (room.x + 0.35) * T;
    const maxX = Math.max(minX, (room.x + room.w - 0.35) * T);
    const minY = (room.y + 0.35) * T;
    const maxY = Math.max(minY, (room.y + room.h - 0.35) * T);

    for (let attempt = 0; attempt < 24; attempt++) {
      const x = minX + this.rng() * (maxX - minX);
      const y = minY + this.rng() * (maxY - minY);
      if (!this.village.roomBlockedArea(room, x, y)) return { x, y };
    }
    return this.doorCentre(room);
  }

  // Indoors, a blocked box is furniture: stop rather than walk over it.
  insideBlockedAt(x, y) {
    return this.village.roomBlockedArea(this.room, x, y);
  }

  updateInside(dt) {
    const room = this.room;
    this.insideTimer -= dt;

    const leaving = this.insideTimer <= 0;
    let target;

    if (leaving) {
      // walk back to the doorway, stepping around furniture, so leaving is a walk
      const door = this.doorCentre(room);
      if (Math.hypot(door.x - this.x, door.y - this.y) <= 2) {
        this.exitRoom();
        return;
      }
      // only a room that is completely boxed in ever jumps to the door, and only after
      // a good while of looking for a way out
      this.leaveTime = (this.leaveTime || 0) + dt;
      if (this.leaveTime > 8) {
        this.exitRoom();
        return;
      }
      if (!this.insideSteps) {
        const route = this.roomPath(room, { x: this.x, y: this.y }, door);
        this.insideSteps = route && route.length ? route : null;
      }
      if (this.insideSteps && this.insideSteps.length) {
        const hop = this.insideSteps[0];
        if (Math.hypot(hop.x - this.x, hop.y - this.y) <= 1.5) this.insideSteps.shift();
        target = this.insideSteps.length ? this.insideSteps[0] : door;
      } else {
        target = door;
      }
    } else {
      if (!this.insideTarget) this.insideTarget = this.randomInsidePoint(room);
      target = this.insideTarget;
    }

    const dx = target.x - this.x;
    const dy = target.y - this.y;
    const dist = Math.hypot(dx, dy);

    if (dist < 0.001) {
      this.moving = false;
      return;
    }

    if (!leaving && dist < 2) {
      this.insideTarget = this.randomInsidePoint(room);
      this.moving = false;
      return;
    }

    const step = Math.min(this.speed * 0.7 * dt, dist);
    let nx = this.x + (dx / dist) * step;
    let ny = this.y + (dy / dist) * step;
    // Furniture is never walked through, on the way in or on the way out. When the
    // straight line is blocked the villager slides along it instead of stopping dead.
    if (this.insideBlockedAt(nx, ny)) {
      const slideY = this.y + Math.sign(ny - this.y) * step;
      const slideX = this.x + Math.sign(nx - this.x) * step;
      if (Math.abs(ny - this.y) > 0.01 && !this.insideBlockedAt(this.x, slideY)) {
        nx = this.x;
        ny = slideY;
      } else if (Math.abs(nx - this.x) > 0.01 && !this.insideBlockedAt(slideX, this.y)) {
        nx = slideX;
        ny = this.y;
      } else {
        this.insideBumps = (this.insideBumps || 0) + 1;
        if (leaving) {
          this.insideSteps = null; // look for another way round next tick
        } else {
          this.insideTarget = this.randomInsidePoint(room);
        }
        this.moving = false;
        return;
      }
    }
    this.insideBumps = 0;
    this.x = nx;
    this.y = ny;
    this.moving = true;
    if (Math.abs(dx) > 0.5) this.facing = dx > 0 ? 1 : -1;
  }

  // A route across the open floor of a room, on half-tile squares, so stepping out
  // walks around the furniture. Null when the door cannot be reached.
  roomPath(room, from, to) {
    const T = this.village.tileSize;
    const gw = Math.max(1, Math.round(room.w * 2));
    const gh = Math.max(1, Math.round(room.h * 2));
    const xOf = (gx) => (room.x + (gx + 0.5) / 2) * T;
    const yOf = (gy) => (room.y + (gy + 0.5) / 2) * T;
    const cellX = (x) => Math.min(gw - 1, Math.max(0, Math.floor((x / T - room.x) * 2)));
    const cellY = (y) => Math.min(gh - 1, Math.max(0, Math.floor((y / T - room.y) * 2)));
    // Point test, not the padded footprint: the way to the door is a line a villager
    // can walk along, and padding every cell by the body width would seal the doorway
    // whenever the tiles beside it are blocked.
    const open = (gx, gy) => !this.village.isRoomBlockedAt(room, xOf(gx), yOf(gy));

    const startIdx = cellY(from.y) * gw + cellX(from.x);
    const goalIdx = cellY(to.y) * gw + cellX(to.x);
    const prev = new Int32Array(gw * gh).fill(-1);
    const seen = new Uint8Array(gw * gh);
    const queue = [startIdx];
    seen[startIdx] = 1;

    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head];
      if (cur === goalIdx) break;
      const cx = cur % gw;
      const cy = (cur - cx) / gw;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const nIdx = ny * gw + nx;
        if (seen[nIdx] || !open(nx, ny)) continue;
        seen[nIdx] = 1;
        prev[nIdx] = cur;
        queue.push(nIdx);
      }
    }
    if (!seen[goalIdx]) return null;

    const route = [];
    for (let cur = goalIdx; cur !== startIdx && cur !== -1; cur = prev[cur]) {
      const cx = cur % gw;
      route.push({ x: xOf(cx), y: yOf((cur - cx) / gw) });
    }
    route.reverse();
    return route;
  }

  // ------------------------------------------------------------------- drawing
  draw(ctx) {
    const sim = this.sim || {};
    // A fight is a short lunge towards the other villager, not a new sprite: the
    // body strip steps forward and back while the sword swings in the hand.
    const attackLeft = sim.attackUntil ? sim.attackUntil - Date.now() : 0;
    const attacking = attackLeft > 0;
    // A thrust that reaches towards the other villager, not a swing on the spot.
    const thrust = attacking ? Math.round(Math.sin((1 - attackLeft / 320) * Math.PI) * 5) : 0;
    // A hit knocks the defender a couple of pixels back.
    const recoil = sim.hurtUntil && Date.now() < sim.hurtUntil ? 2 : 0;
    // Being punished makes them shrink a pixel; being petted makes them bob.
    const bow = sim.react === 'punish' ? 1 : 0;
    // Dazed villagers sway and sag where they stand until the stun runs out.
    const dazed = sim.stunned ? Math.round(Math.sin(this.animTime * 16)) : 0;
    const slump = sim.stunned ? 3 : 0;
    const px = Math.round(this.x) + (thrust - recoil) * this.facing + dazed;
    const py = Math.round(this.y) + bow + slump;

    const sheet = this.moving ? this.sheets.walk : this.sheets.idle;
    const frames = this.moving ? WALK_FRAMES : IDLE_FRAMES;
    const fps = this.moving ? 9 : 6;
    const frame = Math.floor(this.animTime * fps) % frames;

    const sx = frame * CELL_W;
    ctx.imageSmoothingEnabled = false;

    // A small warm shadow marks the one body the keyboard is driving. It stays part
    // of the world, so it scales with the map instead of becoming a screen overlay.
    if (this.isPlayer) {
      ctx.save();
      ctx.fillStyle = 'rgba(255, 233, 168, 0.22)';
      ctx.beginPath();
      ctx.ellipse(px, py + 1, 8, 3.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.save();
    if (this.facing === -1) {
      ctx.translate(px, 0);
      ctx.scale(-1, 1);
      ctx.translate(-px, 0);
    }
    if (sheet) {
      ctx.drawImage(
        sheet,
        sx, 0, CELL_W, CELL_H,
        px - FEET_X, py - FEET_Y, CELL_W, CELL_H,
      );
    }
    // inside the facing flip, so the item stays in the same hand when they turn
    drawHeldItem(ctx, this, px, py);
    ctx.restore();

    this.drawName(ctx);
    drawEmote(ctx, this, Math.round(this.x), py);
  }

  // The name floats over the villager in the pack's pixel font. It is drawn in world
  // space, so it scales with the map like everything else.
  drawName(ctx) {
    if (!this.name) return;
    const px = Math.round(this.x);
    const py = Math.round(this.y) - 21; // the body is 16px tall above the feet

    ctx.save();
    ctx.font = '8px "Pixelify Sans", ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(23, 20, 42, 0.88)';
    ctx.strokeText(this.name, px, py);
    ctx.fillStyle = this.isPlayer ? '#ffe9a8' : '#fff4cf';
    ctx.fillText(this.name, px, py);
    ctx.restore();
  }
}
