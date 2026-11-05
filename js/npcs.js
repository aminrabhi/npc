// Who lives in the village.
//
// A villager is never drawn from scratch: every look is a stack of the pack's own
// sprite strips, which are authored on the same 96x64 cell grid. The body is the
// bottom layer, the hand strip (the pack's "tools" sheets - the held-object layer)
// goes on top of it so anything a villager carries stays glued to their hands, and
// the hair strip goes last so it always sits on the head.
//
// The roster itself is baked data (data/npcs.json). This module only knows how to
// read it, validate it, and turn an appearance into the two sheets a villager needs.

import { loadImage } from './tiles.js';
import { recolour, registerSkinSource } from './recolor.js';

export const BODIES = [
  { id: 'base', label: 'Base', walk: 'assets/npc/body_walk.png', idle: 'assets/npc/body_idle.png' },
];

export const HAIRS = [
  { id: 'bowlhair', label: 'Bowl', walk: 'assets/npc/bowlhair_walk.png', idle: 'assets/npc/bowlhair_idle.png' },
  { id: 'curlyhair', label: 'Curly', walk: 'assets/npc/curlyhair_walk.png', idle: 'assets/npc/curlyhair_idle.png' },
  { id: 'longhair', label: 'Long', walk: 'assets/npc/longhair_walk.png', idle: 'assets/npc/longhair_idle.png' },
  { id: 'mophair', label: 'Mop', walk: 'assets/npc/mophair_walk.png', idle: 'assets/npc/mophair_idle.png' },
  { id: 'shorthair', label: 'Short', walk: 'assets/npc/shorthair_walk.png', idle: 'assets/npc/shorthair_idle.png' },
  { id: 'spikeyhair', label: 'Spikey', walk: 'assets/npc/spikeyhair_walk.png', idle: 'assets/npc/spikeyhair_idle.png' },
];

export const HANDS = [
  { id: 'none', label: 'Empty', walk: null, idle: null },
  { id: 'tools', label: 'Held tool', walk: 'assets/npc/tools_walk.png', idle: 'assets/npc/tools_idle.png' },
];

// Colour choices offered in the studio. Any hex works; these are just convenient
// starting points that read well against the pack's palette.
export const SHIRT_COLOURS = [
  '#d94f5c', '#e8843c', '#e8c33c', '#6fbf5b', '#3fa89a',
  '#4a7fd4', '#7c62c9', '#c85fae', '#f2efe4', '#2f3340',
];

export const HAIR_COLOURS = [
  '#e43b44', '#ff8c42', '#f2d16b', '#c7e07a', '#59c9a5',
  '#5aa9e6', '#8f7fd6', '#d47fb0', '#e8e0d0', '#3a2a2a',
];

export const SKIN_COLOURS = [
  '#ffe0c4', '#f3c9a3', '#e5ac7c', '#d69368', '#c07a52',
  '#a4633f', '#87502f', '#6b3e25', '#552f1b', '#3f2416',
];

// A dropped request must not stop the whole village loading. Three attempts, with a
// short backoff and a cache-busting query on the retries so a failed response is not
// served again from the browser's memory cache.
async function loadStrip(path) {
  let last;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await loadImage(attempt === 0 ? path : `${path}?retry=${attempt}`);
    } catch (err) {
      last = err;
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
  throw last;
}

async function loadSet(list) {
  const out = new Map();
  for (const entry of list) {
    out.set(entry.id, entry.walk
      ? { walk: await loadStrip(entry.walk), idle: await loadStrip(entry.idle) }
      : { walk: null, idle: null });
  }
  return out;
}

export async function loadNpcAssets() {
  const [bodies, hairs, hands] = await Promise.all([
    loadSet(BODIES),
    loadSet(HAIRS),
    loadSet(HANDS),
  ]);

  // the body strips carry the face, so they define which tones count as skin
  for (const set of bodies.values()) {
    registerSkinSource(set.walk);
    registerSkinSource(set.idle);
  }

  return { bodies, hairs, hands };
}

export function normaliseNpc(raw, index) {
  const home = Array.isArray(raw.home) ? raw.home : [0, 0];
  const personality = Array.isArray(raw.personality)
    ? raw.personality.map((word) => String(word).trim()).filter(Boolean)
    : String(raw.personality || '')
      .split(',')
      .map((word) => word.trim())
      .filter(Boolean);

  return {
    id: String(raw.id || `npc_${index + 1}`),
    name: String(raw.name || 'Villager').slice(0, 24),
    body: raw.body || BODIES[0].id,
    hair: raw.hair || HAIRS[0].id,
    hand: raw.hand || 'none',
    skin: raw.skin || null,
    shirt: raw.shirt || null,
    hairColor: raw.hairColor || null,
    home: [Number(home[0]) | 0, Number(home[1]) | 0],
    backstory: String(raw.backstory || ''),
    personality,
    notes: String(raw.notes || ''),
    // Room and bed this villager was given in the studio; null means "use the
    // assignment baked into data/homes.json".
    homes: raw.homes && raw.homes.room !== undefined && raw.homes.room !== null
      ? { room: Number(raw.homes.room), bed: raw.homes.bed ? String(raw.homes.bed) : null }
      : null,
  };
}

export async function loadNpcRoster(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Failed to load ${url} (${res.status})`);
  const raw = await res.json();
  const list = Array.isArray(raw) ? raw : raw.npcs || [];
  return list.map(normaliseNpc);
}

// Draw a stack of strips (body, then hand, then hair) into one sheet.
function stack(layers) {
  const base = layers.find(Boolean);
  if (!base) return null;
  const canvas = document.createElement('canvas');
  canvas.width = base.width;
  canvas.height = base.height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  for (const layer of layers) if (layer) ctx.drawImage(layer, 0, 0);
  return canvas;
}

// Walk and idle sheets for one appearance, cached by look so the studio can change
// a name without rebuilding sprites.
export function sheetsFor(config, assets, cache) {
  const key = `${config.body}|${config.hair}|${config.hand}|${config.skin || '-'}|${config.shirt || '-'}|${config.hairColor || '-'}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const body = assets.bodies.get(config.body) || assets.bodies.get(BODIES[0].id);
  const hair = assets.hairs.get(config.hair) || assets.hairs.get(HAIRS[0].id);
  const hand = assets.hands.get(config.hand) || assets.hands.get('none');

  // skin is painted on the body and on the hand strip (the held-object layer shows the
  // hand holding it); the hair strip keeps the pack's face tones and only takes hair colour
  const dress = (img) => recolour(recolour(img, 'skin', config.skin), 'shirt', config.shirt);
  const wear = (img) => recolour(img, 'skin', config.skin);

  const sheets = {
    walk: stack([
      dress(body.walk),
      wear(hand.walk),
      recolour(hair.walk, 'hair', config.hairColor),
    ]),
    idle: stack([
      dress(body.idle),
      wear(hand.idle),
      recolour(hair.idle, 'hair', config.hairColor),
    ]),
  };
  cache.set(key, sheets);
  return sheets;
}
