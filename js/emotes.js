// Emotes: the pack's expression icons, drawn above a villager's head.
//
// These are the same expression sprites the pack uses in its own UI: a heart for
// affection, a red cross for stress, an exclamation mark for alarm and a spiral for
// dizziness. They float, shake or spin while they are on screen, so a punish or a
// pet reads as an animated reaction rather than a static badge.

import { loadImage } from './tiles.js';

export const EMOTES = {
  // lift is how far the icon floats up over its life; shake is horizontal wobble in
  // pixels; spin is radians per second.
  love: { id: 'love', src: 'assets/npc/emote_love.png', lift: 5, shake: 0, spin: 0, pulse: true },
  stress: { id: 'stress', src: 'assets/npc/emote_stress.png', lift: 2, shake: 1.6, spin: 0, pulse: false },
  alerted: { id: 'alerted', src: 'assets/npc/emote_alerted.png', lift: 4, shake: 0.8, spin: 0, pulse: true },
  dizzy: { id: 'dizzy', src: 'assets/npc/emote_dizzy.png', lift: 1, shake: 2, spin: 0.7, pulse: false },
};

const sprites = new Map();

export async function loadEmotes() {
  await Promise.all(Object.values(EMOTES).map(async (emote) => {
    try {
      sprites.set(emote.id, await loadImage(emote.src));
    } catch {
      // a missing expression is not worth losing the village over
    }
  }));
  return sprites.size;
}

export function hasEmote(id) {
  return sprites.has(id);
}

// The social layer owns the clock; the drawing side just reads the timestamps.
export function drawEmote(ctx, npc, px, py) {
  const sim = npc && npc.sim;
  if (!sim || !sim.emote) return;
  const emote = EMOTES[sim.emote];
  const sprite = sprites.get(sim.emote);
  if (!emote || !sprite) return;

  const now = Date.now();
  const started = Number(sim.emoteAt) || now;
  const until = Number(sim.emoteUntil) || now + 2000;
  const life = Math.max(0, (now - started) / 1000);
  const fadeIn = Math.min(1, life * 7);
  const fadeOut = Math.max(0, Math.min(1, (until - now) / 420));
  const alpha = Math.min(fadeIn, fadeOut);
  if (alpha <= 0.02) return;

  const rise = emote.lift * Math.min(1, life / 1.1);
  const shake = Math.sin(life * 22) * emote.shake;
  const pulse = emote.pulse ? 1 + Math.sin(life * 8) * 0.08 : 1;

  ctx.save();
  ctx.globalAlpha = alpha;
  // Beside the head rather than above it: speech bubbles are drawn after the
  // villagers and would otherwise cover the expression entirely.
  ctx.translate(px + ((npc.facing || 1) * 13) + shake, py - 17 - rise);
  if (emote.spin) ctx.rotate(Math.sin(life * 3.2) * 0.18 * emote.spin * 4);
  ctx.scale(pulse, pulse);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sprite, -sprite.width / 2, -sprite.height / 2, sprite.width, sprite.height);
  ctx.restore();
}
