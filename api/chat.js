// POST /api/chat
//
// One villager line per request. The browser never sees the Groq key and never talks
// to Groq directly: it sends the personality, relationship and memory context it has,
// this route validates it, builds the prompt and calls Groq.
//
// Guard rails: a hard message cap per conversation, a cap on history and memory
// counts, a per-IP rate limit and a timeout. A conversation cannot run away, and a
// bug in the client cannot turn into an unbounded API bill.

import { route, readJson, requireMethod, sendJson, rateLimit, asString, asNumber, asArray, HttpError, clientKey } from '../server/http.js';
import { chatCompletion, GroqError } from '../server/groq.js';
import { buildMessages } from '../server/prompts.js';
import { config } from '../server/env.js';

const MODES = new Set(['opening', 'reply', 'closing']);
const MAX_MESSAGES = 12;

// Enough for a 10-message conversation plus a closing line, comfortably under the
// 4,096 token window of allam-2-7b.
const TEMPERATURE = { opening: 0.95, reply: 0.85, closing: 0.8 };

function validate(body) {
  const conversationId = asString(body.conversationId, 64);
  if (!conversationId) throw new HttpError(400, 'missing_conversation', 'conversationId is required.');

  const mode = asString(body.mode, 12) || 'reply';
  if (!MODES.has(mode)) throw new HttpError(400, 'bad_mode', 'mode must be opening, reply or closing.');

  const messageCount = Math.round(asNumber(body.messageCount, 0, 0, 999));
  if (messageCount >= MAX_MESSAGES) {
    throw new HttpError(409, 'conversation_full', 'This conversation has reached its message cap.', {
      maxMessages: MAX_MESSAGES,
    });
  }

  if (!body.speaker || !body.speaker.name) {
    throw new HttpError(400, 'missing_speaker', 'speaker.name is required.');
  }
  if (!body.listener || !body.listener.name) {
    throw new HttpError(400, 'missing_listener', 'listener.name is required.');
  }

  const history = asArray(body.history, 16).map((entry) => ({
    speakerId: asString(entry && entry.speakerId, 40),
    speakerName: asString(entry && entry.speakerName, 24),
    text: asString(entry && entry.text, 300),
  })).filter((entry) => entry.text);

  const memories = asArray(body.memories, 8).map((entry) => ({
    description: asString(entry && entry.description, 160),
    aboutName: asString(entry && entry.aboutName, 24),
    kind: asString(entry && entry.kind, 20),
    importance: asNumber(entry && entry.importance, 0.4, 0, 1),
  })).filter((entry) => entry.description);

  const news = asArray(body.news, 3).map((entry) => ({
    headline: asString(entry && entry.headline, 140),
    summary: asString(entry && entry.summary, 140),
    category: asString(entry && entry.category, 20),
  })).filter((entry) => entry.headline);

  const recentLines = asArray(body.recentLines, 4).map((line) => asString(line, 120)).filter(Boolean);

  const relationship = body.relationship && typeof body.relationship === 'object'
    ? {
      score: asNumber(body.relationship.score, 0, -100, 100),
      category: asString(body.relationship.category, 24),
      trust: asNumber(body.relationship.trust, 0.3, 0, 1),
      familiarity: asNumber(body.relationship.familiarity, 0.2, 0, 1),
      dislike: asNumber(body.relationship.dislike, 0, 0, 1),
    }
    : null;

  const relationshipChange = body.relationshipChange && typeof body.relationshipChange === 'object'
    ? {
      kind: asString(body.relationshipChange.kind, 20),
      note: asString(body.relationshipChange.note, 110),
    }
    : null;

  return {
    conversationId,
    mode,
    messageCount,
    speaker: body.speaker,
    listener: body.listener,
    history,
    memories,
    news,
    recentLines,
    relationship,
    relationshipChange,
  };
}

export default route(async (req, res) => {
  requireMethod(req, 'POST');

  if (!config().groqKey) {
    throw new HttpError(503, 'groq_not_configured', 'GROQ_API_KEY is not set on the server, so villagers cannot talk yet.', {
      hint: 'Add GROQ_API_KEY (and optionally GROQ_MODEL=allam-2-7b) to the Vercel project environment variables.',
    });
  }

  // A busy village runs several conversations at once, each asking for one line at a
  // time: a hundred requests a minute is a normal ceiling, not a runaway.
  const limit = rateLimit({ key: `chat:${clientKey(req)}`, limit: 240, windowMs: 60_000 });
  if (!limit.ok) {
    throw new HttpError(429, 'client_rate_limited', 'Too many conversations from this browser right now.', {
      retryAfter: limit.retryAfter,
    });
  }
  const hourly = rateLimit({ key: 'chat:global', limit: 2400, windowMs: 60 * 60_000 });
  if (!hourly.ok) {
    throw new HttpError(429, 'server_rate_limited', 'The village has used its hourly conversation budget.', {
      retryAfter: hourly.retryAfter,
    });
  }

  const body = validate(await readJson(req));
  const messages = buildMessages(body);
  const started = Date.now();

  try {
    const result = await chatCompletion({
      messages,
      temperature: TEMPERATURE[body.mode],
      maxTokens: 96,
      timeoutMs: 13_500,
    });
    sendJson(res, 200, {
      ok: true,
      message: {
        text: result.text,
        // Anything the model wrote past one bubble arrives as a follow-up message
        // instead of being trimmed mid-sentence.
        extra: result.extra || [],
        model: result.model,
        mode: body.mode,
        conversationId: body.conversationId,
        messageNumber: body.messageCount + 1,
      },
      finishReason: result.finishReason,
      usage: result.usage,
      ms: Date.now() - started,
    });
  } catch (error) {
    if (error instanceof GroqError) {
      sendJson(res, error.status, {
        ok: false,
        error: error.toBody(),
        // the configuration point is named so a wrong model is a one-line fix
        modelConfig: 'GROQ_MODEL (server/env.js defaults to allam-2-7b)',
        ms: Date.now() - started,
      });
      return;
    }
    throw error;
  }
});
