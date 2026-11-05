// Where each villager lives.
//
// Houses == the five doorways into the village's hand-drawn interiors. A room record
// carries the door tile and the rectangle of map tiles the interior covers, a bed
// record carries the tile the bed occupies, and an assignment ties a villager to one
// room and one bed. Everything here is plain data so it can be exported as code and
// hardcoded again without touching the behaviour that uses it.

export const HOMES_URL = 'data/homes.json';

// Where the studio keeps the assignments it changes, so a reload does not lose them.
// data/homes.json stays the baked default; this is the player's own version of it.
export const HOMES_STORAGE_KEY = 'aivillage.homes.v1';

export function loadSavedHomes(key = HOMES_STORAGE_KEY) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

function asTile(value) {
  if (!Array.isArray(value) || value.length < 2) return [0, 0];
  return [Number(value[0]) | 0, Number(value[1]) | 0];
}

export function createHomes(raw = {}) {
  const rooms = (raw.rooms || []).map((entry, index) => ({
    id: String(entry.id || `room_${index}`),
    house: String(entry.house || `house_${index}`),
    index: Number.isInteger(entry.index) ? entry.index : index,
    door: asTile(entry.door),
    x: Number(entry.x) | 0,
    y: Number(entry.y) | 0,
    w: Number(entry.w) | 0,
    h: Number(entry.h) | 0,
  }));

  const beds = (raw.beds || []).map((entry, index) => {
    const tile = asTile(entry.tile);
    const stand = Array.isArray(entry.stand) ? entry.stand.map(Number) : [tile[0] + 0.5, tile[1] + 0.5];
    return {
      id: String(entry.id || `bed_${index}`),
      room: Number.isInteger(entry.room) ? entry.room : 0,
      tile,
      stand,
      facing: entry.facing === -1 ? -1 : 1,
    };
  });

  const assignments = new Map();
  for (const [npcId, value] of Object.entries(raw.assignments || {})) {
    if (!value) continue;
    assignments.set(String(npcId), {
      room: Number.isInteger(value.room) ? value.room : null,
      bed: value.bed ? String(value.bed) : null,
    });
  }

  const roomByIndex = (index) => rooms.find((room) => room.index === Number(index)) || null;
  const bedsFor = (index) => beds.filter((bed) => bed.room === Number(index));
  const bedById = (id) => beds.find((bed) => bed.id === id) || null;

  // Nobody is ever left without somewhere to sleep: a villager with no assignment
  // gets a room and a bed of their own, picked by position in the roster.
  function ensureAssignment(npcId, ordinal) {
    const existing = assignments.get(npcId);
    if (existing && roomByIndex(existing.room) && (existing.bed ? bedById(existing.bed) : true)) {
      return existing;
    }
    const room = rooms.length ? rooms[ordinal % rooms.length] : null;
    if (!room) return { room: null, bed: null };
    const options = bedsFor(room.index);
    const bed = options.length ? options[Math.floor(ordinal / Math.max(1, rooms.length)) % options.length] : null;
    const next = { room: room.index, bed: bed ? bed.id : null };
    assignments.set(npcId, next);
    return next;
  }

  const homes = {
    rooms,
    beds,

    room: roomByIndex,
    bedsFor,
    bed: bedById,

    assignment(npcId, ordinal = 0) {
      return ensureAssignment(String(npcId), ordinal);
    },

    assign(npcId, { room, bed }) {
      const next = {
        room: Number.isInteger(room) ? room : null,
        bed: bed ? String(bed) : null,
      };
      assignments.set(String(npcId), next);
      homes.save();
      return next;
    },

    // Persisted assignments, so the studio's work survives a refresh.
    save() {
      try {
        window.localStorage.setItem(HOMES_STORAGE_KEY, JSON.stringify(homes.toJSON()));
      } catch (err) {
        // private mode or a full quota: the export still works, nothing to report
      }
    },

    // Beds already taken by someone else, so two villagers cannot share one unless
    // they were explicitly given the same bed.
    takenBy(npcId) {
      const out = new Set();
      for (const [id, value] of assignments) {
        if (id !== String(npcId) && value.bed) out.add(value.bed);
      }
      return out;
    },

    // World position of a bed: the spot a villager stands on to occupy it.
    bedPoint(bed) {
      if (!bed) return null;
      return { x: bed.stand[0] * 16, y: bed.stand[1] * 16 };
    },

    toJSON() {
      return {
        v: 1,
        rooms: rooms.map((room) => ({
          id: room.id,
          house: room.house,
          index: room.index,
          door: [...room.door],
          x: room.x,
          y: room.y,
          w: room.w,
          h: room.h,
        })),
        beds: beds.map((bed) => ({
          id: bed.id,
          room: bed.room,
          tile: [...bed.tile],
          stand: [...bed.stand],
          facing: bed.facing,
        })),
        assignments: Object.fromEntries(assignments),
      };
    },

    // A single hardcodable module: rooms, beds and assignments in one readable file.
    exportCode() {
      const data = homes.toJSON();
      return [
        '// Room and bed assignments for AI Village.',
        '// Houses are the doorways into the interiors; a room is the rectangle of map',
        '// tiles the interior covers, and a bed is the tile a villager sleeps on.',
        'export const HOMES = ' + JSON.stringify(data, null, 2) + ';',
        '',
        '// Usage: createHomes(HOMES) from js/homes.js.',
      ].join('\n');
    },
  };

  return homes;
}

// Last resort when data/homes.json is missing: spread the roster over the rooms that
// the layout actually has and give everybody a bed of their own.
export function deriveHomes(village, roster) {
  const rooms = (village.rooms || []).map((room, index) => ({
    id: `room_${index}`,
    house: `house_${index}`,
    index,
    door: [room.door.x, room.door.y],
    x: room.x,
    y: room.y,
    w: room.w,
    h: room.h,
  }));

  const suitability = (room, x, y) => {
    const cx = room.x + room.w / 2;
    const cy = room.y + room.h / 2;
    return Math.hypot(x - cx, y - cy);
  };

  const beds = [];
  for (const room of rooms) {
    const source = village.rooms[room.index];
    const open = [];
    for (let y = room.y + 1; y < room.y + room.h - 1; y++) {
      for (let x = room.x + 1; x < room.x + room.w - 1; x++) {
        if (x === room.door[0] && y === room.door[1]) continue;
        if (source && source.blocked && source.blocked[(y - room.y) * room.w + (x - room.x)]) continue;
        open.push({ x, y });
      }
    }
    open.sort((a, b) => suitability(room, a.x, a.y) - suitability(room, b.x, b.y));
    const picks = open.slice(0, 2);
    picks.forEach((spot, i) => {
      beds.push({
        id: `bed_${room.index}${'ab'[i] || i}`,
        room: room.index,
        tile: [spot.x, spot.y],
        stand: [spot.x + 0.5, spot.y + 0.5],
        facing: i === 0 ? 1 : -1,
      });
    });
  }

  const assignments = {};
  roster.forEach((entry, i) => {
    const room = rooms.length ? rooms[i % rooms.length] : null;
    if (!room) return;
    const options = beds.filter((bed) => bed.room === room.index);
    const bed = options.length ? options[Math.floor(i / Math.max(1, rooms.length)) % options.length] : null;
    assignments[entry.id] = { room: room.index, bed: bed ? bed.id : null };
  });

  return createHomes({ v: 1, rooms, beds, assignments });
}

export async function loadHomes(url = HOMES_URL) {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${url} ${res.status}`);
    return createHomes(await res.json());
  } catch (err) {
    console.warn('homes config not loaded, deriving from the layout:', err && err.message);
    return null;
  }
}
