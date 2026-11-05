// /api/conversations
//
// The only place a transcript is ever written to Supabase, and it is only called
// when someone presses SAVE TO SUPABASE in the Conversation Logs panel.
//
//   GET  ?list=1     recent saved conversations (metadata only)
//   GET  ?id=...     one saved conversation with every message, in order
//   POST {...}       save the selected conversation and its messages
//
// A save is idempotent: sending the same conversation twice returns the existing
// record instead of creating a second copy.

import { route, readJson, requireMethod, sendJson, asString, asArray, asNumber, HttpError } from '../server/http.js';
import { isConfigured, select, upsert, TABLES } from '../server/supabase.js';

const MAX_MESSAGES = 40;

function normaliseConversation(raw) {
  const id = asString(raw && (raw.id || raw.conversationId), 64);
  if (!id) throw new HttpError(400, 'missing_conversation_id', 'The conversation has no id.');

  const participants = asArray(raw.participants, 2).map((entry) => ({
    id: asString(entry && entry.id, 40),
    name: asString(entry && entry.name, 24),
  })).filter((entry) => entry.id);

  const initiatorId = asString(raw.initiatorId, 40) || (participants[0] && participants[0].id) || '';
  const responderId = asString(raw.responderId, 40) || (participants[1] && participants[1].id) || '';
  if (!initiatorId || !responderId) {
    throw new HttpError(400, 'missing_participants', 'A conversation needs an initiator and a responder.');
  }

  return {
    id,
    initiator_id: initiatorId,
    responder_id: responderId,
    participants,
    started_at: raw.startedAt || new Date().toISOString(),
    ended_at: raw.endedAt || null,
    message_count: Math.round(asNumber(raw.messageCount, 0, 0, 500)),
    outcome: asString(raw.outcome, 32) || 'complete',
    relationship_context: raw.relationshipContext || null,
    news_refs: raw.newsRefs || [],
    memories: raw.memories || [],
    saved_at: new Date().toISOString(),
    error: asString(raw.error, 240) || null,
  };
}

function normaliseMessages(list, conversationId) {
  return asArray(list, MAX_MESSAGES)
    .map((message, index) => {
      const text = asString(message && message.text, 600);
      if (!text) return null;
      return {
        id: asString(message && message.id, 80) || `${conversationId}_${index + 1}`,
        conversation_id: conversationId,
        speaker_id: asString(message && message.speakerId, 40) || 'unknown',
        speaker_name: asString(message && message.speakerName, 24) || 'Villager',
        text,
        created_at: (message && message.at) || new Date().toISOString(),
        message_no: Math.round(asNumber(message && message.number, index + 1, 1, 999)),
        generated_by: asString(message && message.generatedBy, 16) || 'groq',
        is_closing: !!(message && message.closing),
      };
    })
    .filter(Boolean);
}

function rowToConversation(row) {
  return {
    id: row.id,
    initiatorId: row.initiator_id,
    responderId: row.responder_id,
    participants: row.participants || [],
    startedAt: row.started_at,
    endedAt: row.ended_at,
    messageCount: row.message_count,
    outcome: row.outcome,
    relationshipContext: row.relationship_context,
    newsRefs: row.news_refs || [],
    memories: row.memories || [],
    savedAt: row.saved_at,
    error: row.error,
  };
}

export default route(async (req, res) => {
  const method = requireMethod(req, 'GET', 'POST');

  if (!isConfigured()) {
    throw new HttpError(503, 'supabase_not_configured', 'Saving a transcript needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the server.', {
      missing: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
    });
  }

  if (method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    const id = asString(url.searchParams.get('id'), 64);
    if (id) {
      const [sessions, messages] = await Promise.all([
        select(TABLES.conversations, { eq: { id }, limit: 1 }),
        select(TABLES.messages, { eq: { conversation_id: id }, order: 'message_no.asc', limit: MAX_MESSAGES }),
      ]);
      const session = (sessions || [])[0];
      if (!session) throw new HttpError(404, 'not_saved', 'That conversation has not been saved to Supabase.');
      sendJson(res, 200, {
        ok: true,
        conversation: rowToConversation(session),
        messages: (messages || []).map((row) => ({
          id: row.id,
          speakerId: row.speaker_id,
          speakerName: row.speaker_name,
          text: row.text,
          at: row.created_at,
          number: row.message_no,
          generatedBy: row.generated_by,
          closing: row.is_closing,
        })),
      });
      return;
    }

    const rows = await select(TABLES.conversations, { limit: 30, order: 'saved_at.desc' });
    sendJson(res, 200, {
      ok: true,
      conversations: (rows || []).map((row) => ({
        ...rowToConversation(row),
        messages: undefined,
      })),
    });
    return;
  }

  const body = await readJson(req);
  const conversation = normaliseConversation(body.conversation || body);
  const messages = normaliseMessages(body.messages || [], conversation.id);
  if (!messages.length) throw new HttpError(400, 'no_messages', 'There is nothing to save in that conversation.');

  // Duplicate prevention: a conversation id is saved once. Pressing the button
  // again reports the existing record rather than writing a second transcript.
  const existing = await select(TABLES.conversations, { eq: { id: conversation.id }, limit: 1 });
  if (existing && existing.length) {
    sendJson(res, 200, {
      ok: true,
      alreadySaved: true,
      conversation: rowToConversation(existing[0]),
      savedMessages: existing[0].message_count || messages.length,
    });
    return;
  }

  const savedSessions = await upsert(TABLES.conversations, { ...conversation, message_count: messages.length }, { onConflict: 'id' });
  await upsert(TABLES.messages, messages, { onConflict: 'id', ignoreDuplicates: true });

  sendJson(res, 200, {
    ok: true,
    alreadySaved: false,
    conversation: rowToConversation((savedSessions && savedSessions[0]) || conversation),
    savedMessages: messages.length,
  });
});
