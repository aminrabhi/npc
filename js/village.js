// Loads the tile layout exported from the author's GameMaker room and exposes
// per-layer tile grids plus a walkability mask.

import { ROOM_LAYERS } from './interior.js';

// Half-width of the feet footprint used for collision. A villager is wider than a
// point, so its body has to stay clear of a box rather than slide half into it.
const FOOT_W = 5;
const FOOT_H = 3;

function parseRuns(runs, size) {
  const cells = new Int32Array(size);
  let at = 0;
  for (const [value, count] of runs || []) {
    for (let k = 0; k < count && at < size; k++) cells[at++] = value;
  }
  return cells;
}

export async function loadVillage(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Failed to load ${url} (${res.status})`);
  const raw = await res.json();

  const layers = raw.layers.map((layer) => {
    const cells = new Int32Array(layer.w * layer.h);
    let i = 0;
    for (const [value, count] of layer.runs) {
      for (let k = 0; k < count && i < cells.length; k++) cells[i++] = value;
    }
    return { name: layer.name, w: layer.w, h: layer.h, cells };
  });

  const size = raw.cols * raw.rows;
  const blocked = new Uint8Array(size);
  // 0 open, 1 whole tile, 2 left half, 3 right half: half boxes have to survive the
  // load, otherwise a chair would block its whole tile again.
  let i = 0;
  for (const [value, count] of raw.blocked) {
    const box = value === 1 || value === 2 || value === 3 ? value : 0;
    for (let k = 0; k < count && i < size; k++) blocked[i++] = box;
  }

  // manual collision marks (0 follow the atlas, 1 force block, 2 force walkable)
  const manual = new Int8Array(size);
  if (raw.manual) {
    let j = 0;
    for (const [value, count] of raw.manual) {
      for (let k = 0; k < count && j < size; k++) manual[j++] = value;
    }
  }

  // Doorways and the hand-drawn rooms behind them. A room is a rectangle of map
  // tiles that only shows its art in the editor's door view or while someone is in.
  const rooms = (raw.rooms || []).map((entry) => {
    const w = entry.w | 0;
    const h = entry.h | 0;
    const room = {
      door: { x: entry.door[0] | 0, y: entry.door[1] | 0 },
      x: entry.x | 0,
      y: entry.y | 0,
      w,
      h,
      canvas: null,
    };
    for (const name of ROOM_LAYERS) {
      room[name] = parseRuns(entry[name], w * h);
    }
    // Solid furniture painted indoors. Missing in older layouts, which simply means
    // the whole interior is walkable.
    room.blocked = parseRuns(entry.blocked, w * h);
    return room;
  });

  const tileSize = raw.tileSize;
  const cols = raw.cols;
  const rows = raw.rows;

  // Doorway tiles, and the houses behind them. A room's rectangle covers the house
  // it sits in and its interior art is only ever seen from the inside, so everyone
  // outside has to walk around it instead of through the front wall. The doorway
  // tile itself stays open, otherwise nothing could ever get in.
  const doorways = new Set();
  const solid = blocked.slice();
  for (const room of rooms) {
    doorways.add(room.door.y * cols + room.door.x);
    if (room.w <= 0 || room.h <= 0) continue;
    for (let y = room.y; y < room.y + room.h; y++) {
      for (let x = room.x; x < room.x + room.w; x++) {
        if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
        if (x === room.door.x && y === room.door.y) continue;
        solid[y * cols + x] = 1;
      }
    }
  }

  // A collision box painted on the map underneath a house is furniture indoors: the
  // room's art is drawn over those tiles, so the box has to live in the room's own
  // mask as well, otherwise a villager walks straight over it once inside.
  for (const room of rooms) {
    if (room.w <= 0 || room.h <= 0) continue;
    for (let y = room.y; y < room.y + room.h; y++) {
      for (let x = room.x; x < room.x + room.w; x++) {
        if (x === room.door.x && y === room.door.y) continue;
        const mark = manual[y * cols + x];
        if (mark !== 1 && mark !== 3 && mark !== 4) continue;
        room.blocked[(y - room.y) * room.w + (x - room.x)]
          = mark === 1 ? 1 : mark === 3 ? 2 : 3;
      }
    }
  }

  return {
    tileSize,
    cols,
    rows,
    atlasCols: raw.atlasCols,
    layers,
    rooms,
    blocked,
    manual,
    solid,
    doorways,
    width: cols * tileSize,
    height: rows * tileSize,

    isBlocked(cx, cy) {
      if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return true;
      return blocked[cy * cols + cx] === 1;
    },

    // The box on a tile: 0 open, 1 whole tile, 2 left half, 3 right half.
    blockedValue(cx, cy) {
      if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return 1;
      return solid[cy * cols + cx];
    },

    // what a villager may stand on: the map's own collision plus the houses
    isSolid(cx, cy) {
      return this.blockedValue(cx, cy) === 1;
    },

    // The same test in pixels, so a half-width box only blocks its own half and a
    // villager can walk past the open side of narrow furniture.
    isBlockedAt(px, py) {
      const T = tileSize;
      const cx = Math.floor(px / T);
      const cy = Math.floor(py / T);
      const box = this.blockedValue(cx, cy);
      if (box === 0) return false;
      if (box === 1) return true;
      const leftHalf = px - cx * T < T / 2;
      return box === (leftHalf ? 2 : 3);
    },

    // The feet are a footprint, not a point: its corners are tested so no part of
    // the villager's body ever ends up inside a collision box.
    feetBlockedAt(px, py) {
      return this.isBlockedAt(px - FOOT_W, py) || this.isBlockedAt(px + FOOT_W, py)
        || this.isBlockedAt(px, py - FOOT_H) || this.isBlockedAt(px, py + FOOT_H);
    },

    isDoorway(cx, cy) {
      return doorways.has(cy * cols + cx);
    },

    // Rebuild the walking mask from the collision boxes plus the house footprints.
    // The editor calls this after a paint so a new box is felt straight away.
    rebuildSolid() {
      solid.set(blocked);
      doorways.clear();
      for (const room of rooms) {
        doorways.add(room.door.y * cols + room.door.x);
        if (room.w <= 0 || room.h <= 0) continue;
        for (let y = room.y; y < room.y + room.h; y++) {
          for (let x = room.x; x < room.x + room.w; x++) {
            if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
            if (x === room.door.x && y === room.door.y) continue;
            solid[y * cols + x] = 1;
          }
        }
      }
    },

    // Solid furniture inside a room, in map tile coordinates.
    roomBlockedValue(room, cx, cy) {
      if (!room || !room.blocked) return 0;
      const tx = cx - room.x;
      const ty = cy - room.y;
      if (tx < 0 || ty < 0 || tx >= room.w || ty >= room.h) return 0;
      return room.blocked[ty * room.w + tx];
    },

    isRoomBlocked(room, cx, cy) {
      return this.roomBlockedValue(room, cx, cy) !== 0;
    },

    // Half-width boxes indoors too: a chair can be stepped around, not walked over.
    isRoomBlockedAt(room, px, py) {
      const T = tileSize;
      const cx = Math.floor(px / T);
      const cy = Math.floor(py / T);
      const box = this.roomBlockedValue(room, cx, cy);
      if (box === 0) return false;
      if (box === 1) return true;
      const leftHalf = px - cx * T < T / 2;
      return box === (leftHalf ? 2 : 3);
    },

    // Same footprint test indoors, for furniture painted in the door view.
    roomBlockedArea(room, px, py) {
      return this.isRoomBlockedAt(room, px - FOOT_W, py)
        || this.isRoomBlockedAt(room, px + FOOT_W, py)
        || this.isRoomBlockedAt(room, px, py - FOOT_H)
        || this.isRoomBlockedAt(room, px, py + FOOT_H);
    },

    isWalkable(cx, cy) {
      return !this.isSolid(cx, cy);
    },
  };
}
