// Relationship values and category derivation.
//
// The same rules run in the browser (js/relationships.js) so the panel can show a
// category immediately, and here so a write is never stored with a category that
// contradicts its numbers. One authoritative formula, two copies of ten lines.

import { asNumber, asString, clamp01 } from './http.js';

export const CATEGORIES = [
  'stranger',
  'neutral',
  'acquaintance',
  'friendly',
  'friend',
  'close friend',
  'best friend',
  'disliked',
  'enemy',
];

export function deriveCategory({ score, trust, familiarity, dislike }) {
  const warmth = asNumber(score, 0, -100, 100);
  const t = clamp01(trust, 0);
  const f = clamp01(familiarity, 0);
  const d = clamp01(dislike, 0);
  if (warmth <= -50 || (d >= 0.55 && warmth < -20)) return 'enemy';
  if (warmth <= -12 || d >= 0.4) return 'disliked';
  if (f < 0.1 && t < 0.35) return 'stranger';
  if (warmth < 8) return 'neutral';
  if (warmth < 28) return 'acquaintance';
  if (warmth < 48) return 'friendly';
  if (warmth < 68) return 'friend';
  if (warmth < 86 || t < 0.62 || f < 0.45) return 'close friend';
  return 'best friend';
}

export function normaliseRelationship(npcId, otherId, raw = {}) {
  const score = Math.round(asNumber(raw.score, 0, -100, 100));
  const trust = clamp01(raw.trust, 0.3);
  const familiarity = clamp01(raw.familiarity, 0.08);
  const friendliness = clamp01(raw.friendliness, 0.4);
  const affection = clamp01(raw.affection, 0.1);
  const dislike = clamp01(raw.dislike, 0);
  const interactions = Math.max(0, Math.round(asNumber(raw.interactions, 0, 0, 100000)));
  const category = asString(raw.category, 24);
  return {
    npc_id: npcId,
    other_id: otherId,
    score,
    trust: Number(trust.toFixed(3)),
    familiarity: Number(familiarity.toFixed(3)),
    friendliness: Number(friendliness.toFixed(3)),
    affection: Number(affection.toFixed(3)),
    dislike: Number(dislike.toFixed(3)),
    // a category supplied by the client is accepted only when it agrees with the
    // numbers; otherwise it is derived here
    category: CATEGORIES.includes(category) && category === deriveCategory({ score, trust, familiarity, dislike })
      ? category
      : deriveCategory({ score, trust, familiarity, dislike }),
    interactions,
    last_interaction: raw.lastInteraction || raw.last_interaction || new Date().toISOString(),
    notes: asString(raw.notes, 240) || null,
    updated_at: new Date().toISOString(),
  };
}

export function rowToRelationship(row) {
  return {
    npcId: row.npc_id,
    otherId: row.other_id,
    score: row.score,
    trust: row.trust,
    familiarity: row.familiarity,
    friendliness: row.friendliness,
    affection: row.affection,
    dislike: row.dislike,
    category: row.category,
    interactions: row.interactions,
    lastInteraction: row.last_interaction,
    notes: row.notes,
    updatedAt: row.updated_at,
  };
}
