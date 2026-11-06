// Groq Cloud, server-side only.
//
// One function generates one line of villager dialogue. It never decides movement,
// timing or who speaks next: the simulation owns all of that and only asks for text.
//
// The model comes from server/env.js (GROQ_MODEL, default allam-2-7b). It is never
// silently swapped: if the configured model is rejected, the error says so and says
// where to change it.

import { config } from './env.js';

export class GroqError extends Error {
  constructor(message, { status = 502, code = 'groq_error', retryAfter = null, detail = null, model = null } = {}) {
    super(message);
    this.name = 'GroqError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.detail = detail;
    this.model = model;
  }

  toBody() {
    return {
      code: this.code,
      message: this.message,
      ...(this.model ? { model: this.model } : {}),
      ...(this.retryAfter ? { retryAfter: this.retryAfter } : {}),
      ...(this.detail ? { detail: this.detail } : {}),
    };
  }
}

// Stage directions, markdown and quote wrapping are the usual ways a language model
// slips out of character. The simulation draws the villager; it never needs actions.
const BANNED = [
  /\bas an ai\b/i,
  /\blanguage model\b/i,
  /\bprompt\b/i,
  /\bgroq\b/i,
  /\bapi\b/i,
];

// A speech bubble holds two lines of about 52 characters (four rows at the bubble's
// width). The model is asked to reword a thought until it fits that budget. When it
// still runs over, the rest is spoken as a follow-up message instead of being trimmed
// mid-sentence, so nothing a villager says is cut off.
export const LINE_BUDGET = {
  lineChars: 52,
  lines: 2,
  chars: 110,
  messages: 3,
};

const MAX_LINE_CHARS = LINE_BUDGET.lineChars;
const MAX_LINES = LINE_BUDGET.lines;

// Word wrap a single sentence so no row is wider than a bubble row.
function wrapSentence(sentence, maxChars = MAX_LINE_CHARS) {
  const lines = [];
  let current = '';
  for (const word of String(sentence).split(/\s+/).filter(Boolean)) {
    if (word.length > maxChars) {
      if (current) lines.push(current);
      let rest = word;
      while (rest.length > maxChars) {
        lines.push(rest.slice(0, maxChars));
        rest = rest.slice(maxChars);
      }
      current = rest;
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if (current && candidate.length > maxChars) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// Sentence-aware packing: whole sentences where they fit, an extra message rather
// than a trailing ellipsis where they do not.
function packMessages(sentences, { maxChars, maxLines, maxMessages }) {
  const messages = [];
  let lines = [];
  let used = 0;
  const flush = () => {
    if (!lines.length) return;
    messages.push(lines.join('\n'));
    lines = [];
    used = 0;
  };

  for (const sentence of sentences) {
    const wrapped = wrapSentence(sentence, MAX_LINE_CHARS);
    const joinedLength = used + (lines.length ? 1 : 0) + wrapped.join('\n').length;
    if (lines.length && (lines.length + wrapped.length > maxLines || joinedLength > maxChars)) {
      flush();
    }
    for (const line of wrapped) {
      if (lines.length >= maxLines || (lines.length && used + 1 + line.length > maxChars)) flush();
      lines.push(line);
      used = lines.join('\n').length;
    }
  }
  flush();

  // Last resort only: a reply this long is far beyond what the model was asked for.
  // Even then the extra messages are dropped whole, never squeezed into one wide line.
  const truncated = messages.length > maxMessages;
  return { messages: truncated ? messages.slice(0, maxMessages) : messages, truncated };
}

function finishPiece(text, last) {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return '';
  let joined = lines.join('\n');
  // a villager's line is dialogue, never a paragraph; a split leaves the first part
  // trailing off, the last part finishes cleanly
  if (!/[.!?…]["'”’)]?$/.test(joined)) joined = `${joined}${last ? '.' : '…'}`;
  if (BANNED.some((re) => re.test(joined))) return '';
  return joined;
}

// The spoken line as one or more messages. The first is what the next request answers;
// the rest are follow-ups the browser speaks as separate messages.
export function sanitiseMessages(raw, { maxChars = LINE_BUDGET.chars, maxMessages = LINE_BUDGET.messages } = {}) {
  if (typeof raw !== 'string') return [];
  let text = raw.replace(/\r/g, '');

  // fenced code / stray markup
  text = text.replace(/```[\s\S]*?```/g, ' ');
  // *does something* and [does something]
  text = text.replace(/\*[^*]{1,80}\*/g, ' ');
  text = text.replace(/\[[^\]]{1,80}\]/g, ' ');
  // <acts confused>, <smiles sadly> - the simulation draws the villager, it never
  // needs the model to describe what they are doing
  text = text.replace(/<[^<>]{1,80}>/g, ' ');
  // **bold** / __stress__ markdown has no place in speech
  text = text.replace(/\*\*([^*]{1,80})\*\*/g, '$1');
  text = text.replace(/__([^_]{1,80})__/g, '$1');
  // (sighs) asides, but only a plain lowercase one: (the apples) stays
  text = text.replace(/\(\s*[a-z][a-z' -]{0,30}\s*\)/g, ' ');
  // emoji and pictographs, including variation selectors and zero-width joiners
  text = text.replace(/[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, ' ');
  // wrapping quotes
  text = text.replace(/^\s*["'“”‘’]+/, '').replace(/["'“”‘’]+\s*$/, '');
  // The model sometimes reports its own budget back: "(98 characters)", "- 98 chars",
  // "98/110 characters". That is a note to a developer, not something a villager says.
  text = text.replace(/[([{]\s*\d+\s*(?:\/\s*\d+\s*)?(?:characters?|chars?|words?)\s*[)\]}]/gi, ' ');
  text = text.replace(/[—–-]\s*\d+\s*(?:\/\s*\d+\s*)?(?:characters?|chars?|words?)\b/gi, ' ');
  text = text.replace(/\b\d+\s*(?:\/\s*\d+\s*)?(?:characters?|chars?)\b/gi, ' ');

  // The model is told to break a second thought onto a new line, so line breaks are
  // respected instead of being flattened into one long speech bubble.
  const paragraphs = text
    .split(/\n+/)
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    // "Tiny: ..." on any line, not only the first one
    .map((line) => line.replace(/^[A-Z][\w' .-]{0,20}:\s*/, ''))
    // a quoted line keeps its own pair even when the outer pair was already removed
    .map((line) => line.replace(/^["“”]+\s*/, '').replace(/\s*["“”]+$/, ''))
    .map((line) => (/^['‘]/.test(line) && /['’]$/.test(line)
      ? line.replace(/^['‘]\s*/, '').replace(/\s*['’]$/, '')
      : line))
    .filter(Boolean);
  if (!paragraphs.length) return [];

  const sentences = [];
  for (const paragraph of paragraphs) {
    const parts = paragraph.match(/[^.!?…]+[.!?…]+["'”’)]*|[^.!?…]+$/g) || [paragraph];
    for (const part of parts) {
      const sentence = part.replace(/[ \t]+/g, ' ').trim();
      if (sentence) sentences.push(sentence);
    }
  }
  if (!sentences.length) return [];

  const packed = packMessages(sentences, { maxChars, maxLines: MAX_LINES, maxMessages });
  return packed.messages
    .map((piece, index) => finishPiece(piece, !packed.truncated && index === packed.messages.length - 1))
    .filter(Boolean);
}

// One message only: kept for the shaping tests and any caller that wants a single line.
export function sanitiseLine(raw, maxChars = LINE_BUDGET.chars) {
  return sanitiseMessages(raw, { maxChars, maxMessages: 1 })[0] || '';
}

export async function chatCompletion({
  messages,
  temperature = 0.85,
  maxTokens = 120,
  timeoutMs = 14_000,
  signal = null,
}) {
  const cfg = config();
  if (!cfg.groqKey) {
    throw new GroqError('GROQ_API_KEY is not set on the server.', {
      status: 503,
      code: 'groq_not_configured',
      model: cfg.groqModel,
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => controller.abort(new Error('client_aborted'));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let res;
  try {
    res = await fetch(`${cfg.groqBase}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.groqKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model: cfg.groqModel,
        messages,
        temperature: Math.min(1.6, Math.max(0.05, temperature)),
        max_tokens: Math.min(400, Math.max(32, maxTokens)),
        n: 1,
        stream: false,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    const aborted = controller.signal.aborted;
    throw new GroqError(
      aborted ? 'Groq did not answer in time.' : 'Could not reach Groq.',
      {
        status: aborted ? 504 : 502,
        code: aborted ? 'groq_timeout' : 'groq_unreachable',
        model: cfg.groqModel,
        detail: error && error.message ? String(error.message).slice(0, 160) : null,
      },
    );
  }

  let payload = null;
  const text = await res.text().catch(() => '');
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  clearTimeout(timer);
  if (signal) signal.removeEventListener('abort', onAbort);

  if (!res.ok) {
    const apiError = payload && payload.error ? payload.error : {};
    const apiMessage = typeof apiError.message === 'string' ? apiError.message : '';
    const apiCode = String(apiError.code || apiError.type || '');
    const lower = `${apiCode} ${apiMessage}`.toLowerCase();

    if (res.status === 401 || res.status === 403) {
      throw new GroqError('Groq rejected the API key. Check GROQ_API_KEY.', {
        status: 502,
        code: 'groq_auth_failed',
        model: cfg.groqModel,
        detail: apiMessage || null,
      });
    }
    if (res.status === 404 || lower.includes('model_not_found') || lower.includes('does not exist')) {
      throw new GroqError(
        `Groq has no model called "${cfg.groqModel}". Set GROQ_MODEL (server/env.js defaults to allam-2-7b) to a model your account can use.`,
        { status: 502, code: 'groq_model_unavailable', model: cfg.groqModel, detail: apiMessage || null },
      );
    }
    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after')) || null;
      throw new GroqError('Groq rate limit reached. Conversations will retry shortly.', {
        status: 429,
        code: 'groq_rate_limited',
        retryAfter: retry,
        model: cfg.groqModel,
        detail: apiMessage || null,
      });
    }
    if (res.status === 400 && lower.includes('context')) {
      throw new GroqError('The conversation prompt was too long for the model.', {
        status: 502,
        code: 'groq_context_too_long',
        model: cfg.groqModel,
        detail: apiMessage || null,
      });
    }
    throw new GroqError('Groq could not generate a reply right now.', {
      status: 502,
      code: 'groq_upstream_error',
      model: cfg.groqModel,
      detail: apiMessage ? `${res.status}: ${apiMessage.slice(0, 160)}` : `HTTP ${res.status}`,
    });
  }

  const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
  const content = choice && choice.message ? choice.message.content : '';
  const parts = sanitiseMessages(content);
  if (!parts.length) {
    throw new GroqError('Groq returned an empty or unusable reply.', {
      status: 502,
      code: 'groq_empty_reply',
      model: cfg.groqModel,
      detail: sanitiseDetail(content),
    });
  }

  return {
    text: parts[0],
    extra: parts.slice(1),
    model: (payload && payload.model) || cfg.groqModel,
    usage: payload && payload.usage ? payload.usage : null,
    finishReason: choice ? choice.finish_reason || null : null,
  };
}

function sanitiseDetail(value) {
  if (typeof value !== 'string') return null;
  return value.replace(/\s+/g, ' ').trim().slice(0, 120) || null;
}
