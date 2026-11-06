// Simulora: a small village drawn from the asset pack's tileset, with
// villagers assembled from the pack's separate body and hair strips.
// The whole map is shown at once, scaled to fit the window.

import { loadVillage } from './village.js';
import { buildWorldCanvas, loadImage } from './tiles.js';
import { findPath, largestRegion, doorApproach } from './pathing.js';
import { NPC } from './npc.js';
import { createEditor } from './editor.js';
import { buildRoomCanvas, ROOM_LAYERS } from './interior.js';
import { loadNpcRoster, loadNpcAssets, sheetsFor } from './npcs.js';
import { createNpcStudio } from './npc_studio.js';
import { createClock } from './clock.js';
import { createWeather } from './weather.js';
import { loadHomes, loadSavedHomes, deriveHomes } from './homes.js';
import { createLifestyle } from './lifestyle.js';
import { createHud } from './hud.js';
import { createSimPanel } from './sim_panel.js';
import { loadProfiles, saveProfiles, profileFor } from './personalities.js';
import { createAiClient } from './ai.js';
import { createNewsFeed } from './news.js';
import { createRelationships } from './relationships.js';
import { createMemories } from './memories.js';
import { createConversations } from './conversation.js';
import { createConvLogs } from './conv_logs.js';
import { createRelPanel } from './rel_panel.js';

// Grass marks the tile grid and nothing else, so the area you can place tiles on is
// obvious in any window shape. Everything outside it is painted in this colour.
const SURROUND = '#17142a';

const canvas = document.getElementById('view');
const ctx = canvas.getContext('2d', { alpha: false });

const state = {
  village: null,
  worldCanvas: null,
  atlas: null,
  npcs: [],
  view: { w: 0, h: 0, dpr: 1 },
  scale: 1,
  offset: { x: 0, y: 0 },
  editing: false,
  overlay: null,
  showRooms: false,
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = Math.max(1, Math.floor(w * dpr));
  canvas.height = Math.max(1, Math.floor(h * dpr));
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  state.view = { w, h, dpr };

  if (state.village) {
    // Fill the window: scale so the village covers as much of the viewport as the
    // aspect ratio allows, then centre it. Any margin left over is painted in
    // SURROUND, so grass only ever appears where tiles can be placed.
    const fit = Math.min(w / state.village.width, h / state.village.height);
    state.scale = fit;
    state.offset = {
      x: Math.round((w - state.village.width * state.scale) / 2),
      y: Math.round((h - state.village.height * state.scale) / 2),
    };
  }
  ctx.imageSmoothingEnabled = false;
}

async function init() {
  layout();
  window.addEventListener('resize', layout);

  const rng = mulberry32(20261105);

  const [atlas, village, roster, npcAssets] = await Promise.all([
    loadImage('assets/tileset/sunnyside_16px.png'),
    loadVillage('data/village.json'),
    loadNpcRoster('data/npcs.json'),
    loadNpcAssets(),
  ]);

  // Names are painted straight onto the canvas, so the pixel font has to be ready
  // before the first frame or the labels fall back to a system face.
  try {
    await document.fonts.load('8px "Pixelify Sans"');
  } catch {
    // a font that will not load is no reason to keep the village off the screen
  }

  state.village = village;
  state.atlas = atlas;
  state.worldCanvas = buildWorldCanvas(village, atlas);
  state.roster = roster;
  state.npcAssets = npcAssets;

  // Time and weather are independent of the villagers: the lifestyle machine reads
  // them, the HUD shows them, and the debug panel can override either one.
  state.clock = createClock();
  state.weather = createWeather();
  state.weather.start();

  // Houses, rooms and beds. data/homes.json is the exportable config; a villager's
  // own assignment in the roster wins, so studio choices survive a reload.
  state.homes = (await loadHomes()) || deriveHomes(village, roster);
  // Assignments changed in the studio win over the baked file, so a reload keeps them.
  const savedHomes = loadSavedHomes();
  if (savedHomes && savedHomes.assignments) {
    for (const [npcId, value] of Object.entries(savedHomes.assignments)) {
      if (value && state.homes.room(value.room)) state.homes.assign(npcId, value);
    }
  }
  for (const entry of roster) {
    if (entry.homes && entry.homes.room !== null && entry.homes.room !== undefined) {
      state.homes.assign(entry.id, entry.homes);
    }
  }
  state.sheetCache = new Map();
  state.byId = new Map();
  state.npcs = [];

  document.body.style.background = SURROUND;
  layout();

  const { region, bestId } = largestRegion(village);
  village.region = region;

  // A home has to be somewhere a villager can actually stand. If the map was
  // repainted under one, they move to the closest open cell around it.
  function standable(cell) {
    const { x, y } = cell;
    if (village.blockedValue(x, y) === 0) return { x, y };
    for (let r = 1; r <= 6; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= village.cols || ny >= village.rows) continue;
          if (village.blockedValue(nx, ny) !== 0) continue;
          return { x: nx, y: ny };
        }
      }
    }
    return { x, y };
  }

  // The roster in data/npcs.json is the source of truth: the studio edits it and
  // this keeps the villagers on screen in step without respawning them.
  function syncNpcs() {
    const next = [];
    for (const config of state.roster) {
      const home = standable({ x: config.home[0], y: config.home[1] });
      config.home = [home.x, home.y];

      let npc = state.byId.get(config.id);
      if (!npc) {
        const sheets = sheetsFor(config, npcAssets, state.sheetCache);
        npc = new NPC({
          village,
          sheets,
          name: config.name,
          home,
          config,
          regionId: region[home.y * village.cols + home.x],
          rng,
        });
        state.byId.set(config.id, npc);
      } else {
        npc.sheets = sheetsFor(config, npcAssets, state.sheetCache);
        npc.name = config.name || '';
        npc.config = config;
        npc.setHome(home);
        npc.regionId = region[home.y * village.cols + home.x];
      }
      next.push(npc);
    }
    for (const id of [...state.byId.keys()]) {
      if (!state.roster.some((config) => config.id === id)) state.byId.delete(id);
    }
    state.npcs = next;
  }

  state.syncNpcs = syncNpcs;
  syncNpcs();

  // Part 2: the social layer. Personalities come from the roster, dialogue from the
  // server-side Groq route, and relationships and memories save themselves in the
  // background. The browser never holds a Groq key.
  loadProfiles(state.roster);
  state.ai = createAiClient();
  // Which server features exist is answered once, and the persistence queues stay
  // silent until the server says it can store anything.
  const persistEnabled = () => state.ai.status().supabase;
  state.aiReady = state.ai.probe().catch(() => null);
  state.news = createNewsFeed();
  state.news.start();
  state.relationships = createRelationships({ enabled: persistEnabled });
  state.memories = createMemories({ enabled: persistEnabled });
  state.conversations = createConversations({
    roster: state.roster,
    ai: state.ai,
    relationships: state.relationships,
    memories: state.memories,
    news: state.news,
    rng,
    // the lifestyle machine hands the pair back once the chat is over
    onHandBack: (npc) => { if (state.lifestyles) state.lifestyles.handBack(npc); },
    // What a villager would notice at this moment. Read fresh for every line, so a
    // conversation that runs past sunset starts mentioning the evening.
    environment: () => {
      const sky = state.weather.state();
      return {
        timeOfDay: state.clock.phase(),
        weather: {
          key: sky.key,
          label: sky.label,
          temperature: sky.temperature,
          wet: sky.wet,
          snowy: sky.snowy,
        },
      };
    },
  });

  // Once the probe answers, pull what this village already remembers from Supabase
  // and push anything the first seconds of simulation produced.
  state.aiReady.then(() => {
    if (!persistEnabled()) return;
    state.relationships.load().catch(() => {});
    state.relationships.saveNow();
    state.memories.saveNow();
  });

  state.lifestyles = createLifestyle({
    village,
    homes: state.homes,
    clock: state.clock,
    weather: state.weather,
    roster: state.roster,
    getNpcs: () => state.npcs,
    rng,
    conversations: state.conversations,
    // a friendship pulls two villagers together; a grudge keeps them apart
    partnerAppeal: (a, b) => state.relationships.appeal(a, b),
  });
  // Open the site with every villager where they sleep: standing on their own bed in
  // the room that bed belongs to, instead of in the middle of the street.
  function spawnAtBeds() {
    const homes = state.homes;
    if (!homes) return;
    const T = village.tileSize;
    state.npcs.forEach((npc, ordinal) => {
      const id = npc.config ? npc.config.id : null;
      if (!id) return;
      const assignment = homes.assignment(id, ordinal);
      const bed = assignment.bed ? homes.bed(assignment.bed) : null;
      const record = assignment.room !== null ? homes.room(assignment.room) : null;
      const room = record ? village.rooms[record.index] : null;
      if (!bed || !room) return;
      const point = { x: bed.stand[0] * T, y: bed.stand[1] * T };
      npc.room = room;
      npc.x = point.x;
      npc.y = point.y;
      npc.facing = bed.facing;
      npc.path = [];
      npc.moving = false;
      npc.insideTarget = point;
      npc.insideTimer = 1e9;
      npc.sim = {
        state: 'chilling',
        timer: 6 + rng() * 6,
        dialogue: null,
        partner: null,
        roomIndex: room.index,
        bed,
        seated: true,
        failTime: 0,
        bedTime: 0,
        approachTime: 0,
        previous: null,
        visitRoom: null,
        session: null,
      };
    });
  }
  spawnAtBeds();

  state.hud = createHud({ village, clock: state.clock, weather: state.weather });

  state.editor = createEditor({
    canvas,
    state,
    atlas,
    onEditingChanged(open) {
      state.editing = open;
      // Villagers hold still while the map is being repainted, so a half-finished
      // house never leaves someone standing inside a wall.
      for (const npc of state.npcs) {
        npc.path = [];
        npc.moving = false;
      }
    },
    onLayoutChanged() {
      const { region } = largestRegion(village);
      village.region = region;
      for (const npc of state.npcs) {
        // Someone indoors stays indoors unless the room they are in no longer exists;
        // replanAll() releases stale rooms. Otherwise closing the editor would empty
        // every house.
        npc.pendingRoom = null;

        // if a house was just built where someone was standing, step them to the
        // nearest open tile instead of leaving them stranded inside a wall
        let t = npc.tile;
        if (!npc.room && village.blockedValue(t.x, t.y) !== 0) {
          for (let r = 1; r <= 3 && village.blockedValue(t.x, t.y) !== 0; r++) {
            for (let dy = -r; dy <= r; dy++) {
              for (let dx = -r; dx <= r; dx++) {
                const nx = t.x + dx;
                const ny = t.y + dy;
                if (village.blockedValue(nx, ny) === 0) {
                  npc.x = nx * village.tileSize + village.tileSize / 2;
                  npc.y = ny * village.tileSize + village.tileSize / 2;
                  t = { x: nx, y: ny };
                  break;
                }
              }
              if (village.blockedValue(t.x, t.y) === 0) break;
            }
          }
        }

        npc.regionId = region[t.y * village.cols + t.x];
        npc.path = [];
        npc.waitTime = 0.2;
      }
      if (state.lifestyles) state.lifestyles.replanAll();
    },
  });

  // Hook used by the tooling and for poking at edits from the console.
  window.__editor = state.editor;

  // The npc studio is its own panel: it never touches the tileset, it only edits
  // who lives in the village and what they look like.
  state.studio = createNpcStudio({
    canvas,
    state,
    village,
    assets: npcAssets,
    sheetsFor: (config) => sheetsFor(config, npcAssets, state.sheetCache),
    onChange() {
      syncNpcs();
      // personalities edited in the studio survive a reload
      saveProfiles(state.roster);
    },
  });
  window.__studio = state.studio;

  // One extra button on the existing editor panel opens the simulation controls.
  state.simPanel = createSimPanel({
    clock: state.clock,
    weather: state.weather,
    lifestyle: state.lifestyles,
    getNpcs: () => state.npcs,
    ai: state.ai,
    conversations: state.conversations,
  });

  // The second extra button on the same panel: Conversation Logs, where a transcript
  // can be read and - only by hand - written to Supabase.
  state.convLogs = createConvLogs({
    conversations: state.conversations,
    relationships: state.relationships,
    memories: state.memories,
    news: state.news,
    ai: state.ai,
    roster: state.roster,
  });

  // The third dock panel: the social graph itself, so the numbers behind the
  // conversations are readable without opening the browser console.
  state.relPanel = createRelPanel({
    relationships: state.relationships,
    roster: state.roster,
    conversations: state.conversations,
  });
  window.__conv = state.conversations;
  window.__rel = state.relationships;
  window.__mem = state.memories;
  window.__news = state.news;
  window.__ai = state.ai;
  window.__logs = state.convLogs;
  window.__relPanel = state.relPanel;
  window.__profiles = () => state.roster.map((entry) => profileFor(entry));
  window.__npcs = () => state.roster.map((config) => ({ ...config, home: [...config.home] }));

  // Hooks used by the screenshot tooling.
  window.__worldImage = () => state.worldCanvas.toDataURL('image/png');
  window.__view = () => ({ scale: state.scale, offset: { ...state.offset } });
  window.__bubbles = () => state.hud.bubbles();

  window.__debug = () => state.npcs.map((npc) => {
    const tile = npc.tile;
    return {
      x: Number(npc.x.toFixed(2)),
      y: Number(npc.y.toFixed(2)),
      blocked: !npc.room && village.isSolid(tile.x, tile.y),
      moving: npc.moving,
      inside: npc.room ? village.rooms.indexOf(npc.room) : null,
      name: npc.name,
      home: [npc.home.x, npc.home.y],
      activity: npc.room ? 'inside'
        : npc.pendingRoom ? 'to-door'
          : npc.moving ? 'walking' : 'idle',
      waiting: Number(npc.waitTime.toFixed(2)),
    };
  });

  window.__rooms = () => village.rooms.map((r) => ({
    door: [r.door.x, r.door.y],
    x: r.x, y: r.y, w: r.w, h: r.h,
    drawn: ROOM_LAYERS.reduce(
      (n, name) => n + r[name].reduce((m, v) => m + (v ? 1 : 0), 0), 0),
  }));

  window.__roomsShown = () => state.showRooms;

  // Hooks used by the doorway tooling: the live villager and room objects.
  window.__npc = (index = 0) => state.npcs[index];
  window.__room = (index = 0) => state.village.rooms[index];

  // Everything the simulation tooling needs to look at in one place.
  window.__sim = () => ({
    time: state.clock.label(),
    minutes: state.clock.totalMinutes(),
    phase: state.clock.phase(),
    night: state.clock.isNight(),
    debugTime: state.clock.isOverridden(),
    debugWeather: state.weather.isOverridden(),
    weather: state.weather.state(),
    states: state.lifestyles.states(),
    npcs: state.lifestyles.snapshot(),
  });

  // Direct handles for the tooling: the same objects the village runs on.
  window.__clock = state.clock;
  window.__weather = state.weather;
  window.__homes = state.homes;
  window.__lifestyle = state.lifestyles;
  window.__hud = state.hud;

  // Debug hook: send the first villager through a doorway so the room can be
  // watched opening and closing without waiting for a random door visit.
  // The lifestyle machine owns the door errands now, so the hook goes through it:
  // the villager walks in, stays a while, then carries on with their day.
  window.__visitRoom = (index = 0, npcIndex = 0) => state.lifestyles.visit(state.npcs[npcIndex], village.rooms[index]);

  // The village is ready: drop the loading screen just before the first frame.
  document.getElementById('loading').hidden = true;
  requestAnimationFrame(frame);
}

function frame(time) {
  if (!frame.last) frame.last = time;
  let dt = (time - frame.last) / 1000;
  frame.last = time;
  dt = Math.min(dt, 0.05);

  if (!state.editing) {
    state.lifestyles.update(dt);
  }
  render();
  requestAnimationFrame(frame);
}

function render() {
  const { worldCanvas, view, scale, offset } = state;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = SURROUND;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const s = scale * view.dpr;
  ctx.setTransform(s, 0, 0, s, Math.round(offset.x * view.dpr), Math.round(offset.y * view.dpr));
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(worldCanvas, 0, 0);

  // A room's hand-drawn interior is hidden on the map unless the editor's door
  // view is on or someone has stepped through that door.
  const T = state.village.tileSize;
  const shownRooms = new Set();
  if (state.showRooms) {
    for (const room of state.village.rooms) if (room.w > 0 && room.h > 0) shownRooms.add(room);
  }
  for (const npc of state.npcs) if (npc.room) shownRooms.add(npc.room);
  for (const room of shownRooms) {
    if (!room.canvas) {
      room.canvas = buildRoomCanvas({
        room,
        atlas: state.atlas,
        tileSize: T,
        atlasCols: state.village.atlasCols,
      });
    }
    ctx.drawImage(room.canvas, room.x * T, room.y * T);
  }

  // back-to-front so villagers overlap naturally
  const sorted = state.npcs.slice().sort((a, b) => a.y - b.y);
  for (const npc of sorted) npc.draw(ctx);

  // light, weather and the little dialogue bubbles sit above the villagers
  state.hud.draw(ctx, state.npcs);

  if (state.overlay) state.overlay(ctx);
  if (state.npcOverlay) state.npcOverlay(ctx);
}

init().catch((error) => {
  console.error(error);
  document.getElementById('loading').hidden = true;
  const box = document.getElementById('error');
  box.hidden = false;
  box.textContent = `Could not start the village: ${error.message}`;
});
