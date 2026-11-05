// /api/relationships
//
// GET  ?npcId=npc_03   every relationship that villager holds (relationships are
//                      directional: A's view of B and B's view of A are two rows)
// POST { updates: [] } background save of changed relationships. The category is
//                      re-derived here from the numbers, so a stale or tampered
//                      category can never be stored.
//
// Like memories, this never depends on a transcript being saved.

import { route, readJson, requireMethod, sendJson, asString, asArray, HttpError } from '../server/http.js';
import { isConfigured, select, upsert, TABLES } from '../server/supabase.js';
import { normaliseRelationship, rowToRelationship } from '../server/relationships.js';

export default route(async (req, res) => {
  const method = requireMethod(req, 'GET', 'POST');

  if (!isConfigured()) {
    throw new HttpError(503, 'supabase_not_configured', 'Relationships need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the server.', {
      missing: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
    });
  }

  if (method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    const npcId = asString(url.searchParams.get('npcId'), 40);
    const rows = await select(TABLES.relationships, {
      eq: npcId ? { npc_id: npcId } : {},
      limit: 400,
      order: 'updated_at.desc',
    });
    sendJson(res, 200, {
      ok: true,
      relationships: (rows || []).map(rowToRelationship),
    });
    return;
  }

  const body = await readJson(req);
  const updates = asArray(body.updates, 40);
  if (!updates.length) {
    sendJson(res, 200, { ok: true, saved: 0 });
    return;
  }

  const rows = [];
  for (const update of updates) {
    const npcId = asString(update && update.npcId, 40);
    const otherId = asString(update && update.otherId, 40);
    if (!npcId || !otherId || npcId === otherId) continue;
    rows.push(normaliseRelationship(npcId, otherId, update));
  }
  if (!rows.length) throw new HttpError(400, 'no_valid_relationships', 'Each update needs npcId and otherId.');

  const saved = await upsert(TABLES.relationships, rows, { onConflict: 'npc_id,other_id' });
  sendJson(res, 200, {
    ok: true,
    saved: Array.isArray(saved) ? saved.length : rows.length,
    relationships: (Array.isArray(saved) ? saved : []).map(rowToRelationship),
  });
});
