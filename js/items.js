// Things a villager can carry in their hand.
//
// The sprites come straight from the Sunnyside pack's UI folder: a small diagonal
// sword, axe and pickaxe. They are drawn as an overlay on the sprite cell at hand
// height, inside the same facing flip as the body, so the item stays in the hand
// whichever way the villager turns and swings with them during a fight.

import { loadImage } from './tiles.js';

export const ITEMS = {
  sword: { id: 'sword', label: 'Sword', src: 'assets/npc/item_sword.png', angle: -0.15 },
  axe: { id: 'axe', label: 'Axe', src: 'assets/npc/item_axe.png', angle: -0.1 },
  pickaxe: { id: 'pickaxe', label: 'Pickaxe', src: 'assets/npc/item_pickaxe.png', angle: -0.1 },
};

const sprites = new Map();

export async function loadItems() {
  await Promise.all(Object.values(ITEMS).map(async (item) => {
    try {
      sprites.set(item.id, await loadImage(item.src));
    } catch {
      // a missing icon must not stop the village from loading
    }
  }));
  return sprites.size;
}

export function hasItem(id) {
  return sprites.has(id);
}

export function itemLabel(id) {
  return ITEMS[id] ? ITEMS[id].label : '';
}

// What is actually in the hand right now. A fighter is always holding a sword,
// whatever they were carrying before the argument started.
export function heldItemOf(npc) {
  if (!npc) return null;
  if (npc.sim && npc.sim.fighting) return 'sword';
  return npc.heldItem || null;
}

// px/py is the villager's feet position in world space. The item is anchored at
// the hand around chest height and swings back and forth while a fight is running.
export function drawHeldItem(ctx, npc, px, py) {
  const id = heldItemOf(npc);
  if (!id) return;
  const sprite = sprites.get(id);
  if (!sprite) return;

  const sim = npc.sim || {};
  const attacking = sim.attackUntil && Date.now() < sim.attackUntil;
  const swing = sim.fighting
    ? Math.sin(npc.animTime * (attacking ? 24 : 10)) * (attacking ? 0.95 : 0.55)
    : 0;
  const bob = sim.react === 'pet' ? Math.sin(npc.animTime * 14) : 0;
  const rest = ITEMS[id].angle;

  ctx.save();
  ctx.translate(px + 8, py - 9 + bob);
  ctx.rotate(rest + swing);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sprite, -7, -7, 14, 14);
  ctx.restore();
}
