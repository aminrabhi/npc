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

export function sanitiseLine(raw, maxChars = 220) {
  if (typeof raw !== 'string') return '';
  let text = raw.replace(/\r/g, ' ').replace(/\n+/g, ' ');

  // fenced code / stray markup
  text = text.replace(/```[\s\S]*?```/g, ' ');
  // *does something* and [does something]
  text = text.replace(/\*[^*]{1,80}\*/g, ' ');
  text = text.replace(/\[[^\]]{1,80}\]/g, ' ');
  // a leading "Leonda:" or "LEONDA -"
  text = text.replace(/^\s*[A-Z][\w' .-]{0,23}\s*[:\-—]\s*/, '');
  // wrapping quotes
  text = text.replace(/^\s*["'“”‘’]+/, '').replace(/["'“”‘’]+\s*$/, '');
  text = text.replace(/\s+/g, ' ').trim();

  if (!text) return '';
  if (BANNED.some((re) => re.test(text))) return '';

  if (text.length > maxChars) {
    const cut = text.slice(0, maxChars);
    const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    text = stop > 60 ? cut.slice(0, stop + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`;
  }
  // a villager's line is dialogue, never a paragraph
  if (!/[.!?…]["'”’)]?$/.test(text)) text = `${text}.`;
  return text;
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
  const line = sanitiseLine(content);
  if (!line) {
    throw new GroqError('Groq returned an empty or unusable reply.', {
      status: 502,
      code: 'groq_empty_reply',
      model: cfg.groqModel,
      detail: sanitiseDetail(content),
    });
  }

  return {
    text: line,
    model: (payload && payload.model) || cfg.groqModel,
    usage: payload && payload.usage ? payload.usage : null,
    finishReason: choice ? choice.finish_reason || null : null,
  };
}

function sanitiseDetail(value) {
  if (typeof value !== 'string') return null;
  return value.replace(/\s+/g, ' ').trim().slice(0, 120) || null;
}
