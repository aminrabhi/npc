// /api/memories
//
// GET  ?npcId=npc_03&limit=20   the memories that matter to one villager, ranked by
//                               importance and recency, including what others
//                               remember about them
// POST { memories: [...] }      background save. Idempotent: every memory carries a
//                               stable id and duplicates are ignored by the database,
//                               so a retry after a flaky network cannot double up.
//
// This route stands on its own. It is called by the simulation on its own schedule
// and has nothing to do with whether a transcript is ever saved manually.

import { route, readJson, requireMethod, sendJson, asString, asArray, asNumber, HttpError } from '../server/http.js';
import { isConfigured, select, upsert, TABLES } from '../server/supabase.js';
import { normaliseMemory, rankMemories, rowToMemory } from '../server/memories.js';

export default route(async (req, res) => {
  const method = requireMethod(req, 'GET', 'POST');

  if (!isConfigured()) {
    throw new HttpError(503, 'supabase_not_configured', 'Memories need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the server.', {
      missing: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
    });
  }

  if (method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    const npcId = asString(url.searchParams.get('npcId'), 40);
    if (!npcId) throw new HttpError(400, 'missing_npc', 'npcId is required.');
    const limit = Math.round(asNumber(url.searchParams.get('limit'), 20, 1, 60));

    const [mine, aboutMe] = await Promise.all([
      select(TABLES.memories, { eq: { npc_id: npcId }, limit: limit * 2 }),
      select(TABLES.memories, { eq: { about_npc_id: npcId }, limit }),
    ]);

    const seen = new Set();
    const rows = [];
    for (const row of [...(mine || []), ...(aboutMe || [])]) {
      if (!row || seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
    sendJson(res, 200, { ok: true, npcId, memories: rankMemories(rows).slice(0, limit).map(rowToMemory) });
    return;
  }

  const body = await readJson(req);
  const incoming = asArray(body.memories, 40);
  if (!incoming.length) {
    sendJson(res, 200, { ok: true, saved: 0, skipped: 0, ids: [] });
    return;
  }

  const rows = [];
  let skipped = 0;
  for (const raw of incoming) {
    const row = normaliseMemory(raw);
    if (row) rows.push(row);
    else skipped += 1;
  }
  if (!rows.length) throw new HttpError(400, 'no_valid_memories', 'No memory had an id, npcId and description.');

  const saved = await upsert(TABLES.memories, rows, { onConflict: 'id', ignoreDuplicates: true });
  sendJson(res, 200, {
    ok: true,
    saved: Array.isArray(saved) ? saved.length : rows.length,
    skipped,
    ids: rows.map((row) => row.id),
  });
});
