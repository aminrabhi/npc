// Memory records: validation and shaping.
//
// A memory is short and meaningful. The client decides which moments deserve one
// (js/memories.js); this module only makes sure what arrives is well formed, has a
// stable id (so a retry cannot duplicate it) and a sane importance score.

import { asString, clamp01 } from './http.js';

export const MEMORY_TYPES = new Set([
  'personal',
  'shared',
  'relationship',
  'conversation',
  'positive',
  'negative',
  'event',
  'milestone',
  'disagreement',
  'news',
  'fact',
  'opinion',
  'rumor',
  'grudge',
  'secret',
  'witnessed',
  'gossip',
  'claim',
  'promise',
]);

export function normaliseMemory(raw) {
  const id = asString(raw && raw.id, 64);
  const npcId = asString(raw && (raw.npcId || raw.npc_id), 40);
  if (!id || !npcId) return null;

  const kind = asString(raw.kind || raw.type, 20).toLowerCase();
  const description = asString(raw.description, 240);
  if (!description) return null;

  const about = asString(raw.aboutNpcId || raw.about_npc_id, 40) || null;
  const source = asString(raw.sourceNpcId || raw.source_npc_id, 40) || null;
  const importance = clamp01(raw.importance, 0.4);

  return {
    id,
    npc_id: npcId,
    about_npc_id: about === npcId ? null : about,
    source_npc_id: source === npcId ? null : source,
    kind: MEMORY_TYPES.has(kind) ? kind : 'event',
    description,
    claim: asString(raw.claim, 180) || null,
    confidence: Number(clamp01(raw.confidence, 0.5).toFixed(3)),
    importance: Number(importance.toFixed(3)),
    context: asString(raw.context, 240) || null,
    conversation_id: asString(raw.conversationId || raw.conversation_id, 64) || null,
    created_at: raw.createdAt || raw.created_at || new Date().toISOString(),
  };
}

export function rowToMemory(row) {
  return {
    id: row.id,
    npcId: row.npc_id,
    aboutNpcId: row.about_npc_id,
    sourceNpcId: row.source_npc_id,
    kind: row.kind,
    description: row.description,
    claim: row.claim,
    confidence: Number(row.confidence) || 0,
    importance: Number(row.importance) || 0,
    context: row.context,
    conversationId: row.conversation_id,
    createdAt: row.created_at,
  };
}

// Memories are ranked by importance and recency together, so a milestone from
// yesterday outranks a small remark from this morning but never buries it entirely.
export function rankMemories(rows, now = Date.now()) {
  return rows
    .map((row) => {
      const ageDays = Math.max(0, (now - new Date(row.created_at || now).getTime()) / 86_400_000);
      const recency = 1 / (1 + ageDays / 7);
      const importance = clamp01(row.importance, 0.3);
      return { row, weight: importance * 0.7 + recency * 0.3 };
    })
    .sort((a, b) => b.weight - a.weight)
    .map((entry) => entry.row);
}

export function importanceFor(kind, extra = 0) {
  const base = {
    milestone: 0.9,
    relationship: 0.7,
    disagreement: 0.75,
    secret: 0.88,
    grudge: 0.82,
    rumor: 0.7,
    gossip: 0.55,
    opinion: 0.55,
    fact: 0.65,
    claim: 0.5,
    promise: 0.72,
    shared: 0.65,
    news: 0.45,
    positive: 0.5,
    negative: 0.6,
    personal: 0.5,
    event: 0.5,
    conversation: 0.35,
  }[kind] ?? 0.4;
  return Number(Math.min(1, base + asNumber(extra, 0, -1, 1) * 0.1).toFixed(3));
}
